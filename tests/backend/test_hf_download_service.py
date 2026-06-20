"""Unit tests for Phase 3 hf_download_service.

Validates:
- repo-id / filename / revision regexes
- _safe_destination path-traversal guard
- start_download validation (invalid input → error, no thread spawned)
- start_download happy-path sets state to "starting" / "downloading" / "done"
- cancel signaling
- get_repo_files end-to-end against a fake HF API (no network)
"""

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.services import hf_download_service  # noqa: E402


def _ctx(tmp_path: Path) -> AppContext:
    """Build an AppContext pointing at tmp_path for models/.

    Default AppPaths uses config.SDCPP_DIR etc.; we override the few paths the
    service touches (models/) so tests stay self-contained.
    """
    return AppContext(
        paths=AppPaths(
            models=tmp_path / "models",
            output=tmp_path / "output",
            output_gallery=tmp_path / "output" / ".gallery",
            output_preview=tmp_path / "output" / ".preview",
        )
    )


# ── validation regexes ────────────────────────────────────────────────────


def test_validate_repo_id_accepts_canonical():
    assert hf_download_service.validate_hf_repo_id("city96/FLUX.1-schnell-gguf") is True
    assert hf_download_service.validate_hf_repo_id("a/b") is True


def test_validate_repo_id_rejects_malformed():
    assert hf_download_service.validate_hf_repo_id("") is False
    assert hf_download_service.validate_hf_repo_id("noslash") is False
    assert hf_download_service.validate_hf_repo_id("/leading") is False
    assert hf_download_service.validate_hf_repo_id("trailing/") is False
    assert hf_download_service.validate_hf_repo_id("-leading/name") is False
    assert hf_download_service.validate_hf_repo_id("name/-leading") is False
    assert hf_download_service.validate_hf_repo_id("a/b/c") is False  # too many slashes
    assert hf_download_service.validate_hf_repo_id("a\\b") is False


def test_validate_filename_accepts_supported_types():
    assert hf_download_service.validate_hf_filename("flux1-schnell-q4_0.gguf") is True
    assert hf_download_service.validate_hf_filename("ae.safetensors") is True
    assert hf_download_service.validate_hf_filename("text_encoder/model.safetensors") is True


def test_validate_filename_rejects_traversal_and_bad_types():
    assert hf_download_service.validate_hf_filename("../escape.gguf") is False
    assert hf_download_service.validate_hf_filename("a/../../escape.gguf") is False
    assert hf_download_service.validate_hf_filename("model.onnx") is False
    assert hf_download_service.validate_hf_filename("README.md") is False
    assert hf_download_service.validate_hf_filename("config.json") is False
    assert hf_download_service.validate_hf_filename("/abs/path.gguf") is False
    # Windows drive letter paths must be rejected (not auto-normalized).
    assert hf_download_service.validate_hf_filename("C:/models/x.gguf") is False
    # Backslash is normalized to forward-slash on Windows — that's intended.
    assert hf_download_service.validate_hf_filename("back\\slash.gguf") is True
    assert hf_download_service.validate_hf_filename("") is False


def test_validate_revision_accepts_branch_and_commit():
    assert hf_download_service.validate_hf_revision(None) is True
    assert hf_download_service.validate_hf_revision("") is True
    assert hf_download_service.validate_hf_revision("main") is True
    assert hf_download_service.validate_hf_revision("feature/foo") is True
    assert hf_download_service.validate_hf_revision("a" * 200) is True


def test_validate_revision_rejects_bad():
    assert hf_download_service.validate_hf_revision("../escape") is False
    assert hf_download_service.validate_hf_revision("a" * 201) is False
    assert hf_download_service.validate_hf_revision("v1; rm -rf /") is False


# ── _safe_destination: path-traversal guard ───────────────────────────────


def test_safe_destination_resolves_under_models(tmp_path):
    ctx = _ctx(tmp_path)
    dest = hf_download_service._safe_destination(ctx.paths.models, "flux.safetensors")
    assert dest == ctx.paths.models / "diffusion" / "flux.safetensors"


def test_safe_destination_allows_nested_subdirs(tmp_path):
    ctx = _ctx(tmp_path)
    dest = hf_download_service._safe_destination(
        ctx.paths.models, "text_encoder/clip_l.safetensors"
    )
    assert dest.parent == ctx.paths.models / "text-encoders" / "text_encoder"


def test_safe_destination_rejects_traversal(tmp_path):
    ctx = _ctx(tmp_path)
    try:
        hf_download_service._safe_destination(ctx.paths.models, "../escape.safetensors")
    except ValueError:
        return
    raise AssertionError("expected ValueError for traversal")


def test_safe_destination_rejects_absolute(tmp_path):
    ctx = _ctx(tmp_path)
    try:
        hf_download_service._safe_destination(ctx.paths.models, "/etc/passwd.safetensors")
    except ValueError:
        return
    raise AssertionError("expected ValueError for absolute path")


# ── start_download: input validation (no thread spawned on invalid) ──────


def test_start_download_rejects_invalid_repo(tmp_path):
    ctx = _ctx(tmp_path)
    res = hf_download_service.start_download(ctx, {"repo_id": "noslash", "files": ["a.gguf"]})
    assert "error" in res
    assert ctx.state.model_download_in_progress is False


def test_start_download_rejects_invalid_filename(tmp_path):
    ctx = _ctx(tmp_path)
    res = hf_download_service.start_download(
        ctx,
        {"repo_id": "owner/repo", "files": ["../escape.gguf"]},
    )
    assert "error" in res


def test_start_download_rejects_empty_files(tmp_path):
    ctx = _ctx(tmp_path)
    res = hf_download_service.start_download(ctx, {"repo_id": "owner/repo", "files": []})
    assert "error" in res


def test_start_download_rejects_invalid_revision(tmp_path):
    ctx = _ctx(tmp_path)
    res = hf_download_service.start_download(
        ctx,
        {"repo_id": "owner/repo", "files": ["a.gguf"], "revision": "bad;rm"},
    )
    assert "error" in res


def test_start_download_rejects_too_many_files(tmp_path):
    ctx = _ctx(tmp_path)
    files = [f"f{i}.gguf" for i in range(hf_download_service.MAX_FILES_PER_DOWNLOAD + 1)]
    res = hf_download_service.start_download(ctx, {"repo_id": "owner/repo", "files": files})
    assert "error" in res


# ── start_download: happy path ───────────────────────────────────────────


def _wait_for_state(ctx, target_states, timeout=5.0):
    """Spin until generation.model_download reaches one of target_states."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = ctx.state.model_download.snapshot()
        if snap.get("status") in target_states:
            return snap
        time.sleep(0.05)
    raise AssertionError(f"Timeout waiting for one of {target_states}; last={snap}")


def test_start_download_dispatches_thread_and_reaches_done(tmp_path, monkeypatch):
    """Stub the per-file downloader to a fast no-op; verify the worker thread
    walks starting → downloading → done and records completed_files."""
    ctx = _ctx(tmp_path)

    def fake_download_one(ctx, repo_id, filename, dest, token):
        # Simulate ~25 KB progress with cancel polling.
        total = 25 * 1024
        for i in range(1, 26):
            if ctx.state.model_download_cancel.is_set():
                raise hf_download_service._DownloadCanceled()
            ctx.state.model_download.update(downloaded=i * 1024, total=total)
            time.sleep(0.002)
        # Pretend the file was written.
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"x")

    monkeypatch.setattr(hf_download_service, "_download_one", fake_download_one)

    result = hf_download_service.start_download(
        ctx,
        {"repo_id": "city96/FLUX.1-schnell-gguf", "files": ["a.gguf", "b.safetensors"]},
    )
    assert "job_id" in result
    assert result["file_count"] == 2

    snap = _wait_for_state(ctx, {"done"}, timeout=5.0)
    assert snap["status"] == "done"
    assert snap["completed_files"] == ["a.gguf", "b.safetensors"]
    assert snap["repo_id"] == "city96/FLUX.1-schnell-gguf"

    # Files should have been written under component folders.
    assert (ctx.paths.models / "diffusion" / "a.gguf").exists()
    assert (ctx.paths.models / "diffusion" / "b.safetensors").exists()

    assert ctx.state.model_download_in_progress is False


def test_start_download_cancel_marks_state_canceled(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)

    cancel_flag = {"hit": False}

    def slow_download_one(ctx, repo_id, filename, dest, token):
        for _ in range(50):
            if ctx.state.model_download_cancel.is_set():
                cancel_flag["hit"] = True
                raise hf_download_service._DownloadCanceled()
            time.sleep(0.01)

    monkeypatch.setattr(hf_download_service, "_download_one", slow_download_one)

    hf_download_service.start_download(
        ctx,
        {"repo_id": "owner/repo", "files": ["a.gguf"]},
    )
    # Let it start.
    _wait_for_state(ctx, {"downloading"}, timeout=2.0)
    # Cancel.
    canceled = hf_download_service.cancel(ctx)
    assert canceled is True

    snap = _wait_for_state(ctx, {"canceled"}, timeout=2.0)
    assert snap["status"] == "canceled"
    assert cancel_flag["hit"] is True
    assert ctx.state.model_download_in_progress is False


def test_start_download_dedups_files(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)

    seen = []

    def recorder(ctx, repo_id, filename, dest, token):
        seen.append(filename)

    monkeypatch.setattr(hf_download_service, "_download_one", recorder)
    monkeypatch.setattr(
        hf_download_service,
        "_safe_destination",
        lambda d, f: d / f,
    )

    hf_download_service.start_download(
        ctx,
        {
            "repo_id": "owner/repo",
            "files": ["a.gguf", "a.gguf", "b.safetensors"],
        },
    )
    _wait_for_state(ctx, {"done"}, timeout=3.0)
    assert seen == ["a.gguf", "b.safetensors"]


def test_start_download_rejects_when_already_running(tmp_path):
    ctx = _ctx(tmp_path)
    ctx.state.model_download_in_progress = True
    try:
        res = hf_download_service.start_download(
            ctx, {"repo_id": "owner/repo", "files": ["a.gguf"]}
        )
        assert "error" in res
    finally:
        ctx.state.model_download_in_progress = False


# ── get_repo_files: end-to-end with a fake HF API ────────────────────────


class _FakeSibling:
    def __init__(self, rfilename, size):
        self.rfilename = rfilename
        self.size = size


class _FakeRepoInfo:
    def __init__(self, files):
        self.siblings = [_FakeSibling(n, s) for n, s in files]


class _FakeHfApi:
    def __init__(self, files, repo_info_files=None, raises=None):
        self._files = files
        self._repo_info_files = repo_info_files or files
        self._raises = raises

    def list_repo_files(self, repo_id, revision="main", token=None):
        if self._raises:
            raise self._raises
        return list(self._files)

    def repo_info(self, repo_id, revision="main", files_metadata=True, token=None):
        return _FakeRepoInfo(self._repo_info_files)


def test_get_repo_files_filters_to_supported_extensions(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    fake = _FakeHfApi(
        files=[
            "flux.safetensors",
            "ae.safetensors",
            "README.md",
            "config.json",
            "model.onnx",  # unsupported type
            "weights.gguf",
            "text_encoder/clip_l.safetensors",
        ],
        repo_info_files=[
            ("flux.safetensors", 1024),
            ("ae.safetensors", 2048),
            ("README.md", 100),
            ("config.json", 50),
            ("model.onnx", 999),
            ("weights.gguf", 4096),
            ("text_encoder/clip_l.safetensors", 512),
        ],
    )
    monkeypatch.setattr(hf_download_service, "HfApi", lambda token=None: fake)

    out = hf_download_service.get_repo_files(ctx, "owner/repo")
    names = [f["name"] for f in out["files"]]
    assert names == [
        "ae.safetensors",
        "flux.safetensors",
        "text_encoder/clip_l.safetensors",
        "weights.gguf",
    ]
    sizes = {f["name"]: f["size"] for f in out["files"]}
    assert sizes["flux.safetensors"] == 1024
    assert sizes["ae.safetensors"] == 2048
    folders = {f["name"]: f["folder"] for f in out["files"]}
    assert folders["flux.safetensors"] == "diffusion"
    assert folders["ae.safetensors"] == "vae"
    assert folders["text_encoder/clip_l.safetensors"] == "text-encoders"
    assert out["count"] == 4
    assert out["total_size"] == 1024 + 2048 + 512 + 4096


def test_get_repo_files_survives_repo_info_failure(tmp_path, monkeypatch):
    """If repo_info fails (e.g. private repo without token), sizes default to 0."""

    class _PartialApi(_FakeHfApi):
        def repo_info(self, *a, **kw):
            raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr(
        hf_download_service, "HfApi", lambda token=None: _PartialApi(["a.gguf", "b.safetensors"])
    )
    out = hf_download_service.get_repo_files(_ctx(tmp_path), "owner/repo")
    assert [f["name"] for f in out["files"]] == ["a.gguf", "b.safetensors"]
    assert all(f["size"] == 0 for f in out["files"])


def test_get_repo_files_translates_listing_error(tmp_path, monkeypatch):
    class _BoomApi(_FakeHfApi):
        def list_repo_files(self, *a, **kw):
            raise RuntimeError("Repository Not Found")

    monkeypatch.setattr(hf_download_service, "HfApi", lambda token=None: _BoomApi([]))
    try:
        hf_download_service.get_repo_files(_ctx(tmp_path), "owner/repo")
    except hf_download_service.RepoListingError as exc:
        assert "Repository Not Found" in str(exc)
        return
    raise AssertionError("expected RepoListingError")
