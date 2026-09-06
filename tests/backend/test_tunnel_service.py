"""Tests for tunnel port policy and cloudflared download integrity."""

import hashlib
import io
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths, ServerConfig  # noqa: E402
from backend.download_security import (  # noqa: E402
    safe_download_basename,
    validate_github_download_url,
)
from backend.services import tunnel_service  # noqa: E402


def make_ctx(tmp_path, *, sd_port=1234, gui_port=5250, sd_status="idle"):
    paths = AppPaths(
        root=tmp_path,
        sdcpp=tmp_path / "sdcpp",
        sdcpp_bin=tmp_path / "sdcpp" / "bin",
        sdcpp_installs=tmp_path / "sdcpp" / "installs",
        models=tmp_path / "models",
        output=tmp_path / "output",
        output_preview=tmp_path / "output" / ".preview",
        output_gallery=tmp_path / "output" / ".gallery",
        presets=tmp_path / "presets",
        config_file=tmp_path / "config.json",
        ui=tmp_path / "ui",
        app_logo=tmp_path / "assets" / "logo.png",
        tools=tmp_path / "tools",
        cloudflared=tmp_path / "tools" / "cloudflared",
    )
    ctx = AppContext(
        paths=paths,
        config=ServerConfig(gui_port=gui_port, sd_server_port=sd_port),
    )
    ctx.services.current_platform = "win32"
    ctx.services.current_arch = "x64"
    ctx.state.sd_server.update(status=sd_status, port=sd_port, host="127.0.0.1")
    return ctx


def test_reject_gui_port(tmp_path):
    ctx = make_ctx(tmp_path, sd_port=1234, gui_port=5250)
    with pytest.raises(ValueError, match="GUI port"):
        tunnel_service.start(ctx, 5250)


def test_reject_ssh_and_random_ports(tmp_path):
    ctx = make_ctx(tmp_path, sd_port=1234, sd_status="idle")
    with pytest.raises(ValueError, match="sd-server port"):
        tunnel_service.start(ctx, 22)
    with pytest.raises(ValueError, match="sd-server port"):
        tunnel_service.start(ctx, 9999)


def test_reject_port_not_matching_running_sd_server(tmp_path):
    ctx = make_ctx(tmp_path, sd_port=1234, sd_status="running")
    ctx.state.sd_server.update(port=2345, status="running")
    with pytest.raises(ValueError, match="2345"):
        tunnel_service.start(ctx, 1234)


def test_accept_configured_sd_server_port_when_idle(tmp_path, monkeypatch):
    ctx = make_ctx(tmp_path, sd_port=1234, sd_status="idle")
    fake_exe = tmp_path / "cloudflared.exe"
    fake_exe.write_bytes(b"x")
    monkeypatch.setattr(tunnel_service, "_ensure_cloudflared", lambda _ctx: fake_exe)

    class FakeProc:
        def poll(self):
            return None

        stdout = io.StringIO("")
        stderr = io.StringIO("")

    fake = FakeProc()
    monkeypatch.setattr(
        tunnel_service.subprocess,
        "Popen",
        lambda *a, **k: fake,
    )
    monkeypatch.setattr(tunnel_service.threading.Thread, "start", lambda self: None)

    snap = tunnel_service.start(ctx, 1234)
    assert snap["status"] == "starting"
    assert ctx.state.remote_tunnel_process is fake


def test_accept_running_sd_server_port(tmp_path, monkeypatch):
    ctx = make_ctx(tmp_path, sd_port=1234, sd_status="running")
    ctx.state.sd_server.update(port=3456, status="running")
    fake_exe = tmp_path / "cloudflared.exe"
    fake_exe.write_bytes(b"x")
    monkeypatch.setattr(tunnel_service, "_ensure_cloudflared", lambda _ctx: fake_exe)

    class FakeProc:
        def poll(self):
            return None

        stdout = io.StringIO("")
        stderr = io.StringIO("")

    fake = FakeProc()
    captured = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        return fake

    monkeypatch.setattr(tunnel_service.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(tunnel_service.threading.Thread, "start", lambda self: None)

    tunnel_service.start(ctx, 3456)
    assert captured["args"][-1] == "http://127.0.0.1:3456"


def test_validate_github_download_url_rejects_evil():
    with pytest.raises(ValueError):
        validate_github_download_url("http://github.com/a/b")
    with pytest.raises(ValueError):
        validate_github_download_url("https://evil.example/payload")
    with pytest.raises(ValueError):
        validate_github_download_url("https://user:pass@github.com/a/b")
    ok = validate_github_download_url(
        "https://github.com/cloudflare/cloudflared/releases/download/v1/x"
    )
    assert ok.startswith("https://github.com/")


def test_safe_basename_rejects_traversal():
    assert safe_download_basename("cloudflared-linux-amd64") == "cloudflared-linux-amd64"
    with pytest.raises(ValueError):
        safe_download_basename("../evil")
    with pytest.raises(ValueError):
        safe_download_basename("foo/bar")
    with pytest.raises(ValueError):
        safe_download_basename("")


def test_download_file_rejects_bad_url(tmp_path):
    ctx = make_ctx(tmp_path)
    dest = tmp_path / "out.bin"
    with pytest.raises(ValueError, match="HTTPS|host"):
        tunnel_service._download_file(ctx, "http://evil.example/x", dest)


def test_find_asset_download_validates_url(tmp_path):
    ctx = make_ctx(tmp_path)

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return (
                b'{"assets":[{"name":"cloudflared-windows-amd64.exe",'
                b'"browser_download_url":"https://evil.example/x.exe"}]}'
            )

    ctx.services.urlopen_with_ssl = lambda *a, **k: FakeResp()
    with pytest.raises(ValueError, match="host"):
        tunnel_service._find_asset_download(ctx, "cloudflared-windows-amd64.exe")


def test_sha256_mismatch_deletes_and_raises(tmp_path, monkeypatch):
    ctx = make_ctx(tmp_path)
    asset = "cloudflared-windows-amd64.exe"
    expected = tunnel_service.CLOUDFLARED_SHA256[asset]
    payload = b"not-the-real-binary"
    assert hashlib.sha256(payload).hexdigest() != expected

    monkeypatch.setattr(
        tunnel_service,
        "_find_asset_download",
        lambda _ctx, _name: (
            "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset
        ),
    )

    def fake_download(_ctx, _url, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)

    with pytest.raises(RuntimeError, match="SHA256 mismatch"):
        tunnel_service._ensure_cloudflared(ctx)

    tmp = ctx.paths.cloudflared / asset
    assert not tmp.exists()
    assert not tunnel_service._exe_path(ctx).exists()


def test_sha256_match_installs_exe(tmp_path, monkeypatch):
    ctx = make_ctx(tmp_path)
    asset = "cloudflared-windows-amd64.exe"
    payload = b"cloudflared-bytes"
    digest = hashlib.sha256(payload).hexdigest()
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, digest)
    monkeypatch.setattr(
        tunnel_service,
        "_find_asset_download",
        lambda _ctx, _name: (
            "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset
        ),
    )

    def fake_download(_ctx, _url, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)
    exe = tunnel_service._ensure_cloudflared(ctx)
    assert exe.exists()
    assert exe.read_bytes() == payload
    assert tunnel_service._read_installed_version(ctx) == tunnel_service.CLOUDFLARED_VERSION
    assert tunnel_service._read_installed_sha256(ctx) == digest


def test_cached_wrong_hash_exe_is_rejected_and_refetched(tmp_path, monkeypatch):
    """Existing on-disk binary with wrong hash must not be returned as-is."""
    ctx = make_ctx(tmp_path)
    asset = "cloudflared-windows-amd64.exe"
    good = b"good-cloudflared"
    bad = b"tampered-or-stale"
    good_digest = hashlib.sha256(good).hexdigest()
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, good_digest)

    exe = tunnel_service._exe_path(ctx)
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_bytes(bad)
    tunnel_service._write_installed_version(ctx)
    # Sidecar claims the good pin; on-disk bytes differ → must re-fetch.
    tunnel_service._write_installed_sha256(ctx, good_digest)
    assert hashlib.sha256(bad).hexdigest() != good_digest

    downloads = []

    monkeypatch.setattr(
        tunnel_service,
        "_find_asset_download",
        lambda _ctx, _name: (
            "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset
        ),
    )

    def fake_download(_ctx, _url, dest):
        downloads.append(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(good)

    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)
    result = tunnel_service._ensure_cloudflared(ctx)
    assert downloads, "wrong-hash cache must trigger re-download"
    assert result.read_bytes() == good
    assert tunnel_service._read_installed_version(ctx) == tunnel_service.CLOUDFLARED_VERSION
    assert tunnel_service._read_installed_sha256(ctx) == good_digest


def test_version_bump_forces_refetch(tmp_path, monkeypatch):
    """VERSION pin mismatch forces re-download even when hash would match old pin."""
    ctx = make_ctx(tmp_path)
    asset = "cloudflared-windows-amd64.exe"
    old_payload = b"old-pinned-build"
    new_payload = b"new-pinned-build"
    new_digest = hashlib.sha256(new_payload).hexdigest()
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, new_digest)

    exe = tunnel_service._exe_path(ctx)
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_bytes(old_payload)
    # Stale VERSION from a previous pin — pin bump must not reuse this binary.
    tunnel_service._version_path(ctx).write_text("0.0.0-stale\n", encoding="utf-8")
    tunnel_service._write_installed_sha256(ctx, hashlib.sha256(old_payload).hexdigest())

    downloads = []
    monkeypatch.setattr(
        tunnel_service,
        "_find_asset_download",
        lambda _ctx, _name: (
            "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset
        ),
    )

    def fake_download(_ctx, _url, dest):
        downloads.append(1)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(new_payload)

    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)
    result = tunnel_service._ensure_cloudflared(ctx)
    assert downloads, "version bump must force re-fetch"
    assert result.read_bytes() == new_payload
    assert tunnel_service._read_installed_version(ctx) == tunnel_service.CLOUDFLARED_VERSION
    assert tunnel_service._read_installed_sha256(ctx) == new_digest


def test_matching_cache_skips_download(tmp_path, monkeypatch):
    ctx = make_ctx(tmp_path)
    asset = "cloudflared-windows-amd64.exe"
    payload = b"already-good"
    digest = hashlib.sha256(payload).hexdigest()
    # Asset pin is independent of the exe sidecar after install (same for raw exe).
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, digest)

    exe = tunnel_service._exe_path(ctx)
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_bytes(payload)
    tunnel_service._write_installed_version(ctx)
    tunnel_service._write_installed_sha256(ctx, digest)

    def boom(*_a, **_k):
        raise AssertionError("must not download when pin+hash match")

    monkeypatch.setattr(tunnel_service, "_find_asset_download", boom)
    monkeypatch.setattr(tunnel_service, "_download_file", boom)
    assert tunnel_service._ensure_cloudflared(ctx) == exe


def _make_cloudflared_tgz(payload: bytes) -> bytes:
    """Build a gzip tar whose member basename is ``cloudflared``."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="cloudflared")
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


def test_darwin_tgz_install_writes_sidecars_and_caches(tmp_path, monkeypatch):
    """Darwin pin is the .tgz; cache must use exe sidecar, not asset pin."""
    ctx = make_ctx(tmp_path)
    ctx.services.current_platform = "darwin"
    ctx.services.current_arch = "arm64"
    asset = "cloudflared-darwin-arm64.tgz"
    payload = b"darwin-cloudflared-binary"
    tgz_bytes = _make_cloudflared_tgz(payload)
    tgz_digest = hashlib.sha256(tgz_bytes).hexdigest()
    exe_digest = hashlib.sha256(payload).hexdigest()
    assert tgz_digest != exe_digest
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, tgz_digest)

    downloads = []
    api_calls = []

    def fake_find(_ctx, _name):
        api_calls.append(1)
        return "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset

    def fake_download(_ctx, _url, dest):
        downloads.append(1)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(tgz_bytes)

    monkeypatch.setattr(tunnel_service, "_find_asset_download", fake_find)
    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)

    exe = tunnel_service._ensure_cloudflared(ctx)
    assert exe == tunnel_service._exe_path(ctx)
    assert exe.read_bytes() == payload
    assert tunnel_service._read_installed_version(ctx) == tunnel_service.CLOUDFLARED_VERSION
    assert tunnel_service._read_installed_sha256(ctx) == exe_digest
    assert downloads == [1]
    assert api_calls == [1]

    # Second ensure: VERSION + exe sidecar match → zero network.
    def boom(*_a, **_k):
        raise AssertionError("darwin cache hit must not download or hit release API")

    monkeypatch.setattr(tunnel_service, "_find_asset_download", boom)
    monkeypatch.setattr(tunnel_service, "_download_file", boom)
    assert tunnel_service._ensure_cloudflared(ctx) == exe
    assert exe.read_bytes() == payload


def test_darwin_tampered_exe_with_correct_version_refetches(tmp_path, monkeypatch):
    """Wrong on-disk exe + correct VERSION must clear and re-download the .tgz."""
    ctx = make_ctx(tmp_path)
    ctx.services.current_platform = "darwin"
    ctx.services.current_arch = "x64"
    asset = "cloudflared-darwin-amd64.tgz"
    good = b"good-darwin-cloudflared"
    bad = b"tampered-darwin-cloudflared"
    tgz_bytes = _make_cloudflared_tgz(good)
    tgz_digest = hashlib.sha256(tgz_bytes).hexdigest()
    good_exe_digest = hashlib.sha256(good).hexdigest()
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, tgz_digest)

    exe = tunnel_service._exe_path(ctx)
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_bytes(bad)
    tunnel_service._write_installed_version(ctx)
    tunnel_service._write_installed_sha256(ctx, good_exe_digest)

    downloads = []

    monkeypatch.setattr(
        tunnel_service,
        "_find_asset_download",
        lambda _ctx, _name: (
            "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset
        ),
    )

    def fake_download(_ctx, _url, dest):
        downloads.append(1)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(tgz_bytes)

    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)
    result = tunnel_service._ensure_cloudflared(ctx)
    assert downloads, "tampered darwin exe must trigger re-download"
    assert result.read_bytes() == good
    assert tunnel_service._read_installed_sha256(ctx) == good_exe_digest


def test_version_alone_without_sha_sidecar_refetches(tmp_path, monkeypatch):
    """Cache must not accept VERSION match without an exe SHA256 sidecar."""
    ctx = make_ctx(tmp_path)
    asset = "cloudflared-windows-amd64.exe"
    payload = b"orphan-version-only"
    digest = hashlib.sha256(payload).hexdigest()
    monkeypatch.setitem(tunnel_service.CLOUDFLARED_SHA256, asset, digest)

    exe = tunnel_service._exe_path(ctx)
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_bytes(payload)
    tunnel_service._write_installed_version(ctx)
    assert tunnel_service._read_installed_sha256(ctx) is None

    downloads = []
    monkeypatch.setattr(
        tunnel_service,
        "_find_asset_download",
        lambda _ctx, _name: (
            "https://github.com/cloudflare/cloudflared/releases/download/x/" + asset
        ),
    )

    def fake_download(_ctx, _url, dest):
        downloads.append(1)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)

    monkeypatch.setattr(tunnel_service, "_download_file", fake_download)
    result = tunnel_service._ensure_cloudflared(ctx)
    assert downloads, "VERSION without SHA256 sidecar must not be a cache hit"
    assert result.read_bytes() == payload
    assert tunnel_service._read_installed_sha256(ctx) == digest


def test_start_revalidates_port_under_lock_after_install(tmp_path, monkeypatch):
    """Port allowed at entry can become invalid during download — fail closed."""
    ctx = make_ctx(tmp_path, sd_port=1234, sd_status="idle")
    fake_exe = tmp_path / "cloudflared.exe"
    fake_exe.write_bytes(b"x")

    def ensure_then_change_port(_ctx):
        # Simulate sd-server port change while cloudflared install runs.
        ctx.state.sd_server.update(status="running", port=9999)
        return fake_exe

    monkeypatch.setattr(tunnel_service, "_ensure_cloudflared", ensure_then_change_port)
    spawned = []

    def boom(*_a, **_k):
        spawned.append(True)
        raise AssertionError("Popen must not run after port re-validation fails")

    monkeypatch.setattr(tunnel_service.subprocess, "Popen", boom)

    with pytest.raises(ValueError, match="9999"):
        tunnel_service.start(ctx, 1234)
    assert not spawned
    assert ctx.state.remote_tunnel_process is None
    assert ctx.state.remote_tunnel.snapshot().get("status") == "error"
