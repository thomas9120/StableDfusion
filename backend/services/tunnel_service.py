"""Cloudflare tunnel lifecycle for exposing the running sd-server."""

import hashlib
import json
import re
import stat
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request

from .. import config
from ..context import AppContext
from ..download_security import (
    safe_download_basename,
    validate_github_download_url,
)

_TRY_URL_RE = re.compile(r"https://[-a-zA-Z0-9.]+\.trycloudflare\.com")

# Pin cloudflared releases. Update CLOUDFLARED_VERSION and every entry in
# CLOUDFLARED_SHA256 together when bumping the pin (hashes from the GitHub
# release asset ``digest`` field for that tag).
CLOUDFLARED_VERSION = "2026.7.3"
CLOUDFLARED_RELEASE_API = (
    f"https://api.github.com/repos/cloudflare/cloudflared/releases/tags/{CLOUDFLARED_VERSION}"
)
CLOUDFLARED_SHA256: dict[str, str] = {
    "cloudflared-windows-amd64.exe": (
        "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841"
    ),
    "cloudflared-linux-amd64": ("9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17"),
    "cloudflared-linux-arm64": ("65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0"),
    "cloudflared-darwin-amd64.tgz": (
        "70d1c8684fa6d14b5843787ec8d1ea8e18b23650e424f4ea43d849a506487c3b"
    ),
    "cloudflared-darwin-arm64.tgz": (
        "90c5a4f914d705fd70c135dba6d80b1791d254b08d6d4136301941f88330dd09"
    ),
}


def _asset_name(ctx: AppContext) -> str:
    platform_name = ctx.services.current_platform
    arch = ctx.services.current_arch
    if platform_name == "win32" and arch == "x64":
        return "cloudflared-windows-amd64.exe"
    if platform_name.startswith("linux") and arch == "x64":
        return "cloudflared-linux-amd64"
    if platform_name.startswith("linux") and arch == "arm64":
        return "cloudflared-linux-arm64"
    if platform_name == "darwin" and arch == "x64":
        return "cloudflared-darwin-amd64.tgz"
    if platform_name == "darwin" and arch == "arm64":
        return "cloudflared-darwin-arm64.tgz"
    raise RuntimeError("No cloudflared release asset is configured for this platform.")


def _exe_path(ctx: AppContext) -> Path:
    suffix = ".exe" if ctx.services.current_platform == "win32" else ""
    return ctx.paths.cloudflared / f"cloudflared{suffix}"


def _version_path(ctx: AppContext) -> Path:
    return ctx.paths.cloudflared / "VERSION"


def _sha256_sidecar_path(ctx: AppContext) -> Path:
    """On-disk SHA256 of the installed executable (not the download asset)."""
    return ctx.paths.cloudflared / "SHA256"


def _read_installed_version(ctx: AppContext) -> str | None:
    path = _version_path(ctx)
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def _write_installed_version(ctx: AppContext) -> None:
    _version_path(ctx).write_text(CLOUDFLARED_VERSION + "\n", encoding="utf-8")


def _read_installed_sha256(ctx: AppContext) -> str | None:
    path = _sha256_sidecar_path(ctx)
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8").strip().lower()
    except OSError:
        return None
    return text or None


def _write_installed_sha256(ctx: AppContext, digest: str) -> None:
    _sha256_sidecar_path(ctx).write_text(digest.lower() + "\n", encoding="utf-8")


def _clear_cloudflared_artifacts(ctx: AppContext) -> None:
    """Remove cached cloudflared binary, pin sidecars, and leftover download temps."""
    exe = _exe_path(ctx)
    version_file = _version_path(ctx)
    sha_file = _sha256_sidecar_path(ctx)
    for path in (exe, version_file, sha_file):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    cloudflared_dir = ctx.paths.cloudflared
    if cloudflared_dir.is_dir():
        for child in cloudflared_dir.iterdir():
            name = child.name
            if name.startswith("cloudflared") and child.is_file():
                try:
                    child.unlink(missing_ok=True)
                except OSError:
                    pass


def _allowed_sd_server_port(ctx: AppContext) -> int:
    """Port the tunnel is allowed to expose (running sd-server, else config default)."""
    snap = ctx.state.sd_server.snapshot()
    status = str(snap.get("status") or "idle")
    if status in {"running", "starting"}:
        try:
            port = int(snap.get("port"))
        except (TypeError, ValueError):
            port = 0
        if 1 <= port <= 65535:
            return port
    return int(ctx.config.sd_server_port)


def _validate_tunnel_port(ctx: AppContext, port: int) -> int:
    try:
        port = int(port)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid tunnel target port.") from exc
    if port < 1 or port > 65535:
        raise ValueError("Tunnel target port must be between 1 and 65535.")

    gui_port = int(ctx.config.gui_port)
    if port == gui_port:
        raise ValueError(
            f"Tunneling the GUI port ({gui_port}) is not allowed; "
            "only the sd-server port may be exposed."
        )

    allowed = _allowed_sd_server_port(ctx)
    if port != allowed:
        raise ValueError(
            f"Tunnel may only target the configured sd-server port ({allowed}), not {port}."
        )
    return port


def _find_asset_download(ctx: AppContext, asset_name: str) -> str:
    asset_name = safe_download_basename(asset_name)
    req = Request(
        CLOUDFLARED_RELEASE_API,
        headers={"User-Agent": "Stable-D-GUI"},
    )
    with ctx.services.urlopen_with_ssl(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for asset in data.get("assets", []):
        name = asset.get("name")
        if name == asset_name:
            url = str(asset.get("browser_download_url") or "")
            return validate_github_download_url(url)
    raise RuntimeError(
        f"Could not find cloudflared asset {asset_name!r} in release {CLOUDFLARED_VERSION}."
    )


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _download_file(ctx: AppContext, url: str, dest: Path) -> None:
    url = validate_github_download_url(url)
    req = Request(url, headers={"User-Agent": "Stable-D-GUI"})
    with ctx.services.urlopen_with_ssl(req, timeout=120) as resp:
        final_url = getattr(resp, "geturl", lambda: url)()
        if final_url:
            validate_github_download_url(str(final_url))
        dest.write_bytes(resp.read())


def _ensure_cloudflared(ctx: AppContext) -> Path:
    """Return a verified cloudflared binary matching the pinned version + SHA.

    ``CLOUDFLARED_SHA256[asset]`` is the hash of the **downloaded asset** (raw
    exe or ``.tgz``), checked on the temp file before install. The installed
    executable's content hash is persisted in a SHA256 sidecar and used for
    cache hits — required on Darwin where the pin is the archive, not the exe.
    Never trusts ``exe.exists()`` or VERSION alone.
    """
    exe = _exe_path(ctx)
    asset = safe_download_basename(_asset_name(ctx))
    expected_sha = CLOUDFLARED_SHA256.get(asset)
    if not expected_sha:
        raise RuntimeError(f"No pinned SHA256 for cloudflared asset {asset!r}.")

    installed_version = _read_installed_version(ctx)
    installed_sha = _read_installed_sha256(ctx)
    if exe.is_file() and installed_version == CLOUDFLARED_VERSION and installed_sha:
        try:
            actual_sha = _sha256_file(exe)
        except OSError:
            actual_sha = ""
        if actual_sha.lower() == installed_sha.lower():
            return exe

    # Missing, wrong version, or wrong/missing sidecar hash — wipe and fetch.
    _clear_cloudflared_artifacts(ctx)
    ctx.paths.cloudflared.mkdir(parents=True, exist_ok=True)
    url = _find_asset_download(ctx, asset)
    tmp = ctx.paths.cloudflared / asset
    try:
        _download_file(ctx, url, tmp)
        actual_sha = _sha256_file(tmp)
        if actual_sha.lower() != expected_sha.lower():
            raise RuntimeError(
                f"SHA256 mismatch for {asset}: expected {expected_sha}, got {actual_sha}."
            )

        if asset.endswith(".tgz"):
            import tarfile

            with tarfile.open(tmp, "r:gz") as tar:
                member = next(
                    (m for m in tar.getmembers() if Path(m.name).name == "cloudflared"),
                    None,
                )
                if member is None:
                    raise RuntimeError("cloudflared archive did not contain the executable.")
                extracted = tar.extractfile(member)
                if extracted is None:
                    raise RuntimeError("cloudflared executable could not be read from archive.")
                exe.write_bytes(extracted.read())
            tmp.unlink(missing_ok=True)
        else:
            tmp.replace(exe)
        exe_sha = _sha256_file(exe)
        _write_installed_version(ctx)
        _write_installed_sha256(ctx, exe_sha)
    except Exception:
        tmp.unlink(missing_ok=True)
        # Leave no half-installed binary/sidecars after a failed verify/write.
        try:
            exe.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            _version_path(ctx).unlink(missing_ok=True)
        except OSError:
            pass
        try:
            _sha256_sidecar_path(ctx).unlink(missing_ok=True)
        except OSError:
            pass
        raise

    if sys.platform != "win32":
        exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return exe


def _append_log(ctx: AppContext, line: str) -> None:
    if not line:
        return
    # The two stream threads (stdout/stderr) call this concurrently; the
    # read-modify-write on ``log`` must be atomic to avoid lost appends.
    with ctx.state.remote_tunnel_log_lock:
        snap = ctx.state.remote_tunnel.snapshot()
        text = (snap.get("log") or "") + line
        if len(text) > config.TUNNEL_LOG_LIMIT:
            text = text[-config.TUNNEL_LOG_LIMIT :]
        updates: dict[str, Any] = {"log": text}
        match = _TRY_URL_RE.search(line)
        if match:
            updates.update(
                status="running",
                url=match.group(0),
                message=f"Tunnel running at {match.group(0)}",
            )
        ctx.state.remote_tunnel.update(**updates)


def _stream(ctx: AppContext, pipe) -> None:
    try:
        for line in iter(pipe.readline, ""):
            _append_log(ctx, line)
    except Exception:
        pass


def _monitor(ctx: AppContext, proc) -> None:
    proc.wait()
    with ctx.state.remote_tunnel_lock:
        if ctx.state.remote_tunnel_process is proc:
            ctx.state.remote_tunnel_process = None
            if ctx.state.remote_tunnel.snapshot().get("status") != "stopping":
                ctx.state.remote_tunnel.update(
                    status="idle",
                    url="",
                    message=f"Remote tunnel stopped with code {proc.returncode}.",
                )


def start(ctx: AppContext, port: int) -> dict:
    port = _validate_tunnel_port(ctx, port)

    # Fast pre-check under the lock: refuse if already running.
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        if proc is not None and proc.poll() is None:
            return ctx.state.remote_tunnel.snapshot()

    # Download/install cloudflared OUTSIDE the lifecycle lock (can take a while
    # on first run), but serialize the shared temp/executable writes.
    try:
        with ctx.state.remote_tunnel_install_lock:
            exe = _ensure_cloudflared(ctx)
    except (OSError, URLError, RuntimeError, ValueError) as exc:
        with ctx.state.remote_tunnel_lock:
            ctx.state.remote_tunnel.update(
                status="error",
                message=f"Failed to start Cloudflare tunnel: {exc}",
            )
        raise

    # Re-acquire the lock to spawn + record. Re-check in case another start won
    # the race during the download. Re-validate port under the lock so a
    # mid-download sd-server port change fails closed instead of tunneling stale.
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        if proc is not None and proc.poll() is None:
            return ctx.state.remote_tunnel.snapshot()
        try:
            port = _validate_tunnel_port(ctx, port)
        except ValueError as exc:
            ctx.state.remote_tunnel.update(
                status="error",
                message=f"Failed to start Cloudflare tunnel: {exc}",
            )
            raise
        args = [str(exe), "tunnel", "--url", f"http://127.0.0.1:{port}"]
        ctx.state.remote_tunnel.update(
            status="starting",
            url="",
            message="Starting Cloudflare tunnel...",
            log="",
        )
        try:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=str(ctx.paths.root),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
            )
        except OSError as exc:
            ctx.state.remote_tunnel.update(
                status="error",
                message=f"Failed to start Cloudflare tunnel: {exc}",
            )
            raise
        ctx.state.remote_tunnel_process = proc
        threading.Thread(target=_stream, args=(ctx, proc.stdout), daemon=True).start()
        threading.Thread(target=_stream, args=(ctx, proc.stderr), daemon=True).start()
        threading.Thread(target=_monitor, args=(ctx, proc), daemon=True).start()
        return ctx.state.remote_tunnel.snapshot()


def stop(ctx: AppContext) -> bool:
    return stop_remote_tunnel(ctx)


def stop_remote_tunnel(ctx: AppContext) -> bool:
    # Take the lock to read/mutate remote_tunnel_process consistently with
    # start() and _monitor(). The blocking terminate/wait run *outside* the
    # lock so start/get_snapshot are not blocked for up to 5s.
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        if proc is None or proc.poll() is not None:
            ctx.state.remote_tunnel_process = None
            ctx.state.remote_tunnel.update(
                status="idle", url="", message="Remote tunnel is not running."
            )
            return False
        ctx.state.remote_tunnel.update(status="stopping", message="Stopping remote tunnel...")
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    # Only clear if a new tunnel hasn't been started in the meantime.
    with ctx.state.remote_tunnel_lock:
        if ctx.state.remote_tunnel_process is proc:
            ctx.state.remote_tunnel_process = None
            ctx.state.remote_tunnel.update(status="idle", url="", message="Remote tunnel stopped.")
    return True


def get_snapshot(ctx: AppContext) -> dict:
    proc = ctx.state.remote_tunnel_process
    snap = ctx.state.remote_tunnel.snapshot()
    if proc is not None and proc.poll() is None:
        return snap
    if snap.get("status") in {"running", "starting", "stopping"}:
        snap = ctx.state.remote_tunnel.update(
            status="idle",
            url="",
            message="Remote tunnel is not running.",
        )
    return snap
