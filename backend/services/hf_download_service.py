"""Hugging Face model/component downloads (Phase 3).

Adapted from LLama-GUI's hf_download.py. Key differences for SD:
- Models are multi-file bundles (diffusion + vae + clip + t5xxl + llm).
- Accepts more extensions than GGUF-only (.safetensors / .ckpt / .pth /
  .pt / .gguf / .sft / .bin).
- Downloads land directly under ``models/`` so the existing model pickers
  see them without extra plumbing.

State slots used (see backend/state.py):
- ``model_download``         — progress snapshot polled by the UI.
- ``model_download_lock``    — guards start/finish transitions.
- ``model_download_cancel``  — set to abort the current download thread.

All external input (repo id, filename, revision) is validated against strict
regexes to prevent path traversal and command injection — the route layer
also enforces them before reaching the service.
"""

import re
import threading
import time
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi  # imported at module level so tests can monkeypatch

from ..context import AppContext

# Phase 3: SD component file types. Diffusers/transformers configs (.json,
# .txt, .md) are NOT listed — we only want weight files in models/.
ALLOWED_EXTENSIONS = (".safetensors", ".ckpt", ".pth", ".pt", ".gguf", ".sft", ".bin")

# Strict repo-id: <owner>/<name>; owner & name start alphanumeric, may
# contain . _ -. Matches HuggingFace's own validation rules.
_REPO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*?/[A-Za-z0-9][A-Za-z0-9._-]*$")

# Filename: must be relative (no parent refs, no absolute paths). Allow
# forward-slash subdirectory paths since HF supports e.g. "sub/dir/file.gguf",
# but reject `..`, leading `/`, backslashes, and control chars.
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._\-]+(?:/[A-Za-z0-9._\-]+)*$")

# Revision: branch/tag/commit-ish. Git ref chars (incl. `/` for branch
# hierarchies like "feature/foo") + max 200.
_SAFE_REVISION_RE = re.compile(r"^[A-Za-z0-9._\-/]{1,200}$")

MAX_FILES_PER_DOWNLOAD = 32
DOWNLOAD_CHUNK = 256 * 1024  # 256 KB


def validate_hf_repo_id(repo_id: str) -> bool:
    return bool(_REPO_ID_RE.match(repo_id or ""))


def validate_hf_filename(filename: str) -> bool:
    raw = (filename or "").strip()
    if not raw:
        return False
    # Reject absolute paths (POSIX /, Windows drive) BEFORE any normalization.
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        return False
    name = raw.replace("\\", "/")
    if ".." in name.split("/"):
        return False
    if not _SAFE_FILENAME_RE.match(name):
        return False
    return name.lower().endswith(ALLOWED_EXTENSIONS)


def validate_hf_revision(revision: str | None) -> bool:
    if revision is None or revision == "":
        return True  # default ("main")
    raw = revision.strip()
    if not raw:
        return True
    # Refuse parent-traversal sequences; the char class alone allows `..` and
    # leading `.` (e.g. `.something`), both of which are illegal as git refs.
    if ".." in raw:
        return False
    if not _SAFE_REVISION_RE.match(raw):
        return False
    return True


# ── Repo listing ────────────────────────────────────────────────────────


def get_repo_files(
    ctx: AppContext, repo_id: str, revision: str = "main", token: str | None = None
) -> Mapping[str, Any]:
    """List files in a HF repo, filtered to SD-component extensions.

    Returns ``{"files": [{"name", "size"}, ...], "revision": ..., "count": ...}``.
    Uses ``huggingface_hub.list_repo_files`` to enumerate, and a single
    ``HfApi.repo_info(files_metadata=True)`` call to populate sizes. Both are
    cached briefly by the library; we do not add our own cache here.
    """
    api = HfApi(token=token)
    try:
        names = api.list_repo_files(repo_id, revision=revision or "main", token=token)
    except Exception as exc:
        # Translate the underlying HfHubHTTPError / RepositoryNotFoundError into
        # a string the route layer can return as a 4xx message.
        raise _RepoListingError(str(exc)) from exc

    # Build name → size map (best-effort; missing sizes are reported as 0).
    sizes: dict[str, int] = {}
    try:
        info = api.repo_info(repo_id, revision=revision or "main", files_metadata=True, token=token)
        for sibling in getattr(info, "siblings", None) or []:
            rfilename = getattr(sibling, "rfilename", None)
            if not rfilename:
                continue
            size = getattr(sibling, "size", None) or 0
            sizes[rfilename] = int(size)
    except Exception:
        # If repo_info fails (e.g. private repo without token), we still have
        # the filename list; sizes default to 0.
        pass

    files: list[dict[str, Any]] = []
    for name in names:
        if not validate_hf_filename(name):
            continue
        files.append({"name": name, "size": sizes.get(name, 0)})

    files.sort(key=lambda f: f["name"].lower())
    return {
        "files": files,
        "revision": revision or "main",
        "count": len(files),
        "total_size": sum(f["size"] for f in files),
    }


class _RepoListingError(Exception):
    """Raised when HF repo listing fails; the route returns 4xx."""


# ── Download (background thread + cancel + progress) ────────────────────


def _safe_destination(models_dir: Path, filename: str) -> Path:
    """Resolve ``models_dir / filename`` and verify it stays inside models_dir.

    Raises ValueError on traversal attempts. Intermediate subdirectories are
    created so HF repos that nest files under e.g. ``text_encoder/`` survive.
    """
    original = (filename or "").strip().replace("\\", "/")
    # Reject absolute paths (Windows drive letters, POSIX leading /) BEFORE we
    # strip the leading slash for the relative resolution below.
    if original.startswith("/") or re.match(r"^[A-Za-z]:", original):
        raise ValueError(f"Absolute path rejected: {filename!r}")
    cleaned = original.lstrip("/")
    if not validate_hf_filename(cleaned):
        raise ValueError(f"Unsafe filename: {filename!r}")
    base = models_dir.resolve()
    target = (models_dir / cleaned).resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ValueError(f"Filename escapes models dir: {filename!r}") from exc
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def _download_one(
    ctx: AppContext,
    repo_id: str,
    filename: str,
    dest: Path,
    token: str | None,
) -> None:
    """Stream one file from HF to ``dest`` with progress + cancel polling."""
    from huggingface_hub import hf_hub_url

    # huggingface_hub >= 1.x: hf_hub_url does NOT accept ``token`` — token auth
    # is added as a Bearer header on the request below.
    url = hf_hub_url(repo_id=repo_id, filename=filename)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "stable-d-gui",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )

    with ctx.services.urlopen_with_ssl(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0) or 0)
        tmp = dest.with_suffix(dest.suffix + ".part")
        downloaded = 0
        try:
            with open(tmp, "wb") as f:
                while True:
                    if ctx.state.model_download_cancel.is_set():
                        raise _DownloadCanceled()
                    chunk = resp.read(DOWNLOAD_CHUNK)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    ctx.state.model_download.update(
                        downloaded=downloaded, total=total or downloaded
                    )
        except _DownloadCanceled:
            # Cleanup partial file so the user can retry.
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        except Exception:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
    tmp.replace(dest)


class _DownloadCanceled(Exception):
    """Internal: raised to abort a single file mid-stream."""


def start_download(ctx: AppContext, request: dict) -> dict[str, Any]:
    """Kick off a multi-file download. Returns immediately with ``job_id``.

    The actual download runs on a daemon thread and reports progress through
    ``ctx.state.model_download``. The route layer's pre-checks already
    validated the request body; we re-validate defensively here so the service
    is safe to call directly (e.g. from tests).
    """
    repo_id = (request.get("repo_id") or "").strip()
    files = request.get("files") or []
    revision = (request.get("revision") or "main").strip() or "main"
    token = (request.get("token") or "").strip() or None

    if not validate_hf_repo_id(repo_id):
        return {"error": "Invalid repo id"}
    if not validate_hf_revision(revision):
        return {"error": "Invalid revision"}
    if not isinstance(files, list) or not files:
        return {"error": "No files selected"}
    if len(files) > MAX_FILES_PER_DOWNLOAD:
        return {"error": f"Too many files (max {MAX_FILES_PER_DOWNLOAD})"}

    cleaned_files: list[str] = []
    for f in files:
        if not isinstance(f, str) or not validate_hf_filename(f):
            return {"error": f"Invalid filename: {f!r}"}
        cleaned_files.append(f.strip())

    # De-duplicate while preserving order.
    seen: set[str] = set()
    unique_files: list[str] = []
    for f in cleaned_files:
        if f not in seen:
            seen.add(f)
            unique_files.append(f)

    with ctx.state.model_download_lock:
        if ctx.state.model_download_in_progress:
            return {"error": "A download is already in progress"}
        ctx.state.model_download_in_progress = True
        ctx.state.model_download_cancel.clear()
        # Plan a stable job_id: timestamp + sanitized repo tail.
        job_id = f"{int(time.time())}_{repo_id.split('/', 1)[-1]}"
        ctx.state.model_download.update(
            status="starting",
            message=f"Preparing to download {len(unique_files)} file(s) from {repo_id}",
            total=0,
            downloaded=0,
            current_file="",
            completed_files=[],
            repo_id=repo_id,
            revision=revision,
            job_id=job_id,
        )

    thread = threading.Thread(
        target=_run_downloads,
        args=(ctx, repo_id, unique_files, revision, token),
        daemon=True,
        name=f"hf-download-{job_id}",
    )
    thread.start()
    return {"job_id": job_id, "file_count": len(unique_files)}


def _run_downloads(
    ctx: AppContext,
    repo_id: str,
    files: list[str],
    revision: str,
    token: str | None,
) -> None:
    """Background worker: downloads each file in order, updating progress."""
    try:
        for filename in files:
            if ctx.state.model_download_cancel.is_set():
                ctx.state.model_download.update(
                    status="canceled",
                    message=f"Canceled before {filename}",
                )
                return

            try:
                dest = _safe_destination(ctx.paths.models, filename)
            except ValueError as exc:
                print(f"[hf_download] unsafe path {filename!r}: {exc}", flush=True)
                ctx.state.model_download.update(
                    status="error",
                    message=f"Unsafe path: {filename}",
                )
                return

            ctx.state.model_download.update(
                status="downloading",
                current_file=filename,
                message=f"Downloading {filename}",
                downloaded=0,
                total=0,
            )

            try:
                _download_one(ctx, repo_id, filename, dest, token)
            except _DownloadCanceled:
                ctx.state.model_download.update(
                    status="canceled",
                    message=f"Canceled during {filename}",
                    current_file="",
                )
                return
            except Exception as exc:
                ctx.state.model_download.update(
                    status="error",
                    message=f"Failed to download {filename}: {exc}",
                    current_file="",
                )
                print(f"[hf_download] {filename}: {exc}", flush=True)
                return

            completed = list(ctx.state.model_download.snapshot().get("completed_files") or [])
            completed.append(filename)
            ctx.state.model_download.update(
                completed_files=completed,
                current_file="",
                message=f"Downloaded {filename}",
            )

        ctx.state.model_download.update(
            status="done",
            message=f"Done — {len(files)} file(s) saved to models/.",
        )
    finally:
        with ctx.state.model_download_lock:
            ctx.state.model_download_in_progress = False


def get_status(ctx: AppContext) -> dict[str, Any]:
    """Return the current download progress snapshot for the UI."""
    return ctx.state.model_download.snapshot()


def cancel(ctx: AppContext) -> bool:
    """Signal the background thread to stop after the current chunk."""
    with ctx.state.model_download_lock:
        if not ctx.state.model_download_in_progress:
            return False
        ctx.state.model_download_cancel.set()
        ctx.state.model_download.update(message="Canceling…")
        return True
