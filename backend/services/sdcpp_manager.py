"""stable-diffusion.cpp release management.

Unlike LLama-GUI (which builds asset names from the release tag),
stable-diffusion.cpp releases are **continuous builds**: the tag is
``master-<n>-<commit>`` and each asset name embeds the commit short-hash, e.g.
``sd-master-92a3b73-bin-win-cuda12-x64.zip``. We therefore **never** construct
asset names from the tag. Instead each backend variant declares an
``asset_pattern`` (a glob) that is matched against a release's ``assets[]``.

See PLAN.md §11.

SHA256: upstream ships **no** checksums (no sha256sums file, no per-asset
``.sha256``, and the GitHub releases API does not populate ``asset["sha256"]``).
We therefore skip checksum verification with a stderr warning — this resolves
PLAN.md §16 open decision #3.
"""

import fnmatch
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from ..context import AppContext

# macOS @rpath/ libraries reported by `otool -L`.
RPATH_LIBRARY_RE = re.compile(r"^\s*@rpath/([^\s(]+)")

# Short-term in-memory cache so the Install tab doesn't hammer GitHub on every
# poll. Bypassed by passing force=True (e.g. a manual refresh). Protected by a
# lock so concurrent requests to /api/releases don't race on reads/writes.
_RELEASES_CACHE: dict[str, Any] = {"data": None, "fetched_at": 0.0}
_RELEASES_CACHE_LOCK = threading.Lock()
_RELEASES_CACHE_TTL = 60.0


def build_backend_specs(current_platform: str, current_arch: str) -> dict[str, dict[str, Any]]:
    """Return ``{variant_key: {label, asset_pattern, companion?}}`` per platform.

    ``asset_pattern`` is a glob (``fnmatch``) matched against each release asset
    filename. A ``companion`` (exact filename) is downloaded alongside the main
    asset — used for the CUDA runtime zip.
    """
    if current_platform == "win32" and current_arch == "x64":
        # avx2 first = recommended default CPU choice.
        return {
            "cpu-avx2": {
                "label": "CPU (AVX2) — recommended",
                "asset_pattern": "*-bin-win-avx2-x64.zip",
            },
            "cpu-avx": {"label": "CPU (AVX)", "asset_pattern": "*-bin-win-avx-x64.zip"},
            "cpu-avx512": {"label": "CPU (AVX512)", "asset_pattern": "*-bin-win-avx512-x64.zip"},
            "cpu-noavx": {"label": "CPU (no AVX)", "asset_pattern": "*-bin-win-noavx-x64.zip"},
            "cuda12": {
                "label": "CUDA 12 (NVIDIA)",
                "asset_pattern": "*-bin-win-cuda12-x64.zip",
                "companion": "cudart-sd-bin-win-cu12-x64.zip",
            },
            "vulkan": {"label": "Vulkan", "asset_pattern": "*-bin-win-vulkan-x64.zip"},
            "rocm-7.1.1": {
                "label": "ROCm 7.1.1 (AMD)",
                "asset_pattern": "*-bin-win-rocm-7.1.1-x64.zip",
            },
            "rocm-7.13.0": {
                "label": "ROCm 7.13.0 (AMD)",
                "asset_pattern": "*-bin-win-rocm-7.13.0-x64.zip",
            },
        }
    if current_platform.startswith("linux") and current_arch == "x64":
        return {
            "cpu": {
                "label": "CPU — recommended",
                "asset_pattern": "*-bin-Linux-Ubuntu-24.04-x86_64.zip",
            },
            "vulkan": {
                "label": "Vulkan",
                "asset_pattern": "*-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
            },
            "rocm-7.2.1": {
                "label": "ROCm 7.2.1 (AMD)",
                "asset_pattern": "*-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.2.1.zip",
            },
            "rocm-7.13.0": {
                "label": "ROCm 7.13.0 (AMD)",
                "asset_pattern": "*-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.13.0.zip",
            },
        }
    if current_platform == "darwin" and current_arch == "arm64":
        # macOS asset embeds the build OS version (e.g. macOS-15.7.7); use a
        # wildcard so this survives upstream version bumps.
        return {
            "metal": {
                "label": "Metal (Apple Silicon)",
                "asset_pattern": "*-bin-Darwin-macOS-*-arm64.zip",
            },
        }
    return {}


def find_asset(assets: list[dict[str, Any]], pattern: str) -> dict[str, Any] | None:
    """Return the first release asset whose name matches ``pattern`` (glob)."""
    for asset in assets or []:
        name = asset.get("name", "")
        if name and fnmatch.fnmatch(name, pattern):
            return asset
    return None


def find_asset_by_name(assets: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    for asset in assets or []:
        if asset.get("name") == name:
            return asset
    return None


def get_releases(ctx: AppContext, force: bool = False) -> list[dict[str, Any]]:
    """Fetch the raw GitHub releases list, with a short in-memory cache."""
    import time

    now = time.time()
    with _RELEASES_CACHE_LOCK:
        if not force and _RELEASES_CACHE["data"] is not None:
            if now - _RELEASES_CACHE["fetched_at"] < _RELEASES_CACHE_TTL:
                return _RELEASES_CACHE["data"]

    req = urllib.request.Request(
        ctx.config.github_api,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "stable-d-gui"},
    )
    with ctx.services.urlopen_with_ssl(req, timeout=30) as resp:
        data = json.loads(resp.read())
    with _RELEASES_CACHE_LOCK:
        _RELEASES_CACHE["data"] = data
        _RELEASES_CACHE["fetched_at"] = now
    return data


def get_release_by_tag(ctx: AppContext, tag: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{ctx.config.github_api}/tags/{tag}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "stable-d-gui"},
    )
    with ctx.services.urlopen_with_ssl(req, timeout=30) as resp:
        return json.loads(resp.read())


def resolve_release(ctx: AppContext, tag: str) -> dict[str, Any] | None:
    """Fetch a release by tag, falling back to scanning the releases list."""
    try:
        return get_release_by_tag(ctx, tag)
    except Exception:
        releases = get_releases(ctx)
        return next((r for r in releases if r.get("tag_name") == tag), None)


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ── download progress helpers ────────────────────────────────────────────────


def set_download_progress(ctx: AppContext, **updates: Any) -> dict[str, Any]:
    return ctx.state.download_progress.update(**updates)


def reset_download_progress(
    ctx: AppContext,
    status: str = "idle",
    message: str = "",
    total: int = 0,
    downloaded: int = 0,
) -> dict[str, Any]:
    return ctx.state.download_progress.replace(
        {"total": total, "downloaded": downloaded, "status": status, "message": message}
    )


def get_download_progress_snapshot(ctx: AppContext) -> dict[str, Any]:
    return ctx.state.download_progress.snapshot()


def download_file(
    ctx: AppContext,
    url: str,
    dest: pathlib.Path,
    progress_cb: Callable[[int, int], None] | None = None,
) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "stable-d-gui"})
    with ctx.services.urlopen_with_ssl(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if progress_cb:
                    progress_cb(downloaded, total)
    return downloaded


# ── extraction ───────────────────────────────────────────────────────────────
# sd-cpp ships .zip archives. We extract every file FLATTENED (basename only)
# into sdcpp/bin/ so sd-cli, sd-server and their shared libs sit together and
# PATH/LD_LIBRARY_PATH resolution works at launch time.


def _extract_zip_flat(zf: zipfile.ZipFile, dest_dir: pathlib.Path) -> None:
    for info in zf.infolist():
        if info.is_dir():
            continue
        fname = pathlib.Path(info.filename).name
        if not fname:
            continue
        out_path = dest_dir / fname
        with zf.open(info, "r") as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst)


def extract_archive_flat(archive_path: pathlib.Path, dest_dir: pathlib.Path) -> None:
    lower = archive_path.name.lower()
    if lower.endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zf:
            _extract_zip_flat(zf, dest_dir)
        return
    raise ValueError(f"Unsupported archive format: {archive_path.name}")


# ── runtime dependency validation (macOS @rpath aware) ───────────────────────


def parse_otool_rpath_libraries(output: str) -> list[str]:
    libraries: list[str] = []
    seen: set[str] = set()
    for line in (output or "").splitlines():
        match = RPATH_LIBRARY_RE.match(line)
        if not match:
            continue
        name = pathlib.PurePosixPath(match.group(1)).name
        if name and name not in seen:
            seen.add(name)
            libraries.append(name)
    return libraries


def get_macos_rpath_libraries(executable: pathlib.Path) -> list[str]:
    result = subprocess.run(
        ["otool", "-L", str(executable)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return parse_otool_rpath_libraries(result.stdout)


def validate_runtime_dependencies(
    ctx: AppContext, tools: Iterable[str] | None = None
) -> dict[str, Any]:
    """Check that tool executables exist and (on macOS) their @rpath libs are present.

    On Windows/Linux the shared libs are resolved via PATH/LD_LIBRARY_PATH at
    launch (process_manager prepends sdcpp/bin), so we only verify executables
    there and report ``ok=True``. On macOS we additionally inspect ``otool -L``
    so a missing .dylib surfaces as "Install Incomplete".
    """
    current_platform = ctx.services.current_platform
    checked_tools: list[str] = []
    missing_executables: list[str] = []
    required: set[str] = set()

    for tool in tools or ctx.services.sdcpp_tools:
        exe_path = ctx.services.find_tool_executable(tool)
        if not exe_path.exists():
            missing_executables.append(ctx.services.get_tool_filename(tool))
            continue
        if current_platform == "darwin":
            try:
                required.update(get_macos_rpath_libraries(exe_path))
                checked_tools.append(tool)
            except (
                FileNotFoundError,
                subprocess.CalledProcessError,
                subprocess.TimeoutExpired,
                OSError,
            ):
                pass
        else:
            checked_tools.append(tool)

    missing_runtime_files: list[str] = []
    if current_platform == "darwin":
        missing_runtime_files = sorted(
            name for name in required if not (ctx.paths.sdcpp_bin / name).exists()
        )

    return {
        "ok": not missing_executables and not missing_runtime_files,
        "checked": bool(checked_tools),
        "checked_tools": checked_tools,
        "required_runtime_files": sorted(required),
        "missing_runtime_files": missing_runtime_files,
        "missing_executables": missing_executables,
    }


# ── install / remove ─────────────────────────────────────────────────────────


def install_release(
    ctx: AppContext,
    tag: str,
    backend: str,
    backend_specs: Mapping[str, Mapping[str, Any]],
) -> bool:
    reset_download_progress(ctx, status="downloading", message=f"Fetching release {tag}...")

    release = resolve_release(ctx, tag)
    if not release:
        set_download_progress(ctx, status="error", message=f"Release {tag} not found")
        return False

    assets = release.get("assets", [])
    backend_spec = backend_specs.get(backend)
    if not backend_spec:
        set_download_progress(ctx, status="error", message=f"Unknown backend: {backend}")
        return False

    asset = find_asset(assets, backend_spec["asset_pattern"])
    if not asset:
        set_download_progress(
            ctx,
            status="error",
            message=(
                f"No asset matching {backend_spec['asset_pattern']} in release {tag}. "
                "Try a different backend or a newer release."
            ),
        )
        return False

    # GitHub release assets carry no sha256 metadata, and upstream ships no
    # checksum file (PLAN §16 #3). Verification is skipped with a warning.
    expected_sha = asset.get("sha256")
    if not expected_sha:
        print(
            f"WARNING: No SHA256 available for {asset['name']}; skipping checksum verification.",
            file=sys.stderr,
        )

    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="sdcpp_install_"))
    try:

        def progress_cb(downloaded: int, total: int) -> None:
            set_download_progress(ctx, downloaded=downloaded, total=total)

        archive_path = tmpdir / asset["name"]
        set_download_progress(ctx, message=f"Downloading {asset['name']}...")
        download_file(ctx, asset["browser_download_url"], archive_path, progress_cb)

        if expected_sha:
            actual_sha = sha256_file(archive_path)
            if actual_sha != expected_sha:
                set_download_progress(
                    ctx, status="error", message=f"SHA256 mismatch for {asset['name']}"
                )
                return False

        companion_archives: list[pathlib.Path] = []
        companion_name = backend_spec.get("companion")
        if companion_name:
            companion_asset = find_asset_by_name(assets, companion_name)
            if companion_asset:
                companion_path = tmpdir / companion_name
                set_download_progress(ctx, message=f"Downloading {companion_name}...")
                download_file(
                    ctx, companion_asset["browser_download_url"], companion_path, progress_cb
                )
                companion_archives.append(companion_path)
            else:
                print(
                    f"WARNING: companion asset {companion_name} not found in {tag}; "
                    "CUDA runtime will be absent.",
                    file=sys.stderr,
                )

        set_download_progress(ctx, status="extracting", message="Extracting binaries...")

        # Wipe and recreate sdcpp/bin so old binaries/libraries don't linger
        # across backend switches (e.g. cuda12 → vulkan). Preserve .gitkeep so
        # the empty-dir placeholder stays tracked.
        if ctx.paths.sdcpp_bin.exists():
            shutil.rmtree(ctx.paths.sdcpp_bin)
        ctx.paths.sdcpp_bin.mkdir(parents=True, exist_ok=True)
        (ctx.paths.sdcpp_bin / ".gitkeep").touch()

        extract_archive_flat(archive_path, ctx.paths.sdcpp_bin)
        for extra in companion_archives:
            extract_archive_flat(extra, ctx.paths.sdcpp_bin)

        # Invalidate the releases cache timestamp-wise is unnecessary; config is
        # the source of truth for "installed".
        ctx.services.save_config(
            {"version": release.get("name", tag), "backend": backend, "tag": tag}
        )
        set_download_progress(ctx, status="done", message=f"Installed {tag} ({backend})")
        return True

    except Exception as exc:
        print(f"[sdcpp_manager] install_release error: {exc}", file=sys.stderr)
        set_download_progress(ctx, status="error", message=str(exc))
        return False
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def remove_sdcpp_files(ctx: AppContext) -> int:
    """Delete everything under ``sdcpp/`` and reset install config.

    Models, presets, and output are untouched. Returns the number of files
    removed (for the UI confirmation message).
    """
    removed = 0
    sdcpp = ctx.paths.sdcpp
    if sdcpp.exists():
        for path in sdcpp.rglob("*"):
            if path.is_file():
                removed += 1
        shutil.rmtree(sdcpp, ignore_errors=True)

    ctx.paths.sdcpp_bin.mkdir(parents=True, exist_ok=True)
    (ctx.paths.sdcpp_bin / ".gitkeep").touch()
    ctx.services.save_config({"version": None, "backend": None, "tag": None})
    return removed
