"""Cloudflare tunnel lifecycle for exposing the running sd-server."""

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

_TRY_URL_RE = re.compile(r"https://[-a-zA-Z0-9.]+\.trycloudflare\.com")


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


def _find_asset_download(ctx: AppContext, asset_name: str) -> str:
    req = Request(
        "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
        headers={"User-Agent": "Stable-D-GUI"},
    )
    with ctx.services.urlopen_with_ssl(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for asset in data.get("assets", []):
        if asset.get("name") == asset_name:
            return str(asset.get("browser_download_url") or "")
    raise RuntimeError(f"Could not find cloudflared asset {asset_name!r}.")


def _download_file(ctx: AppContext, url: str, dest: Path) -> None:
    req = Request(url, headers={"User-Agent": "Stable-D-GUI"})
    with ctx.services.urlopen_with_ssl(req, timeout=120) as resp:
        dest.write_bytes(resp.read())


def _ensure_cloudflared(ctx: AppContext) -> Path:
    exe = _exe_path(ctx)
    if exe.exists():
        return exe
    ctx.paths.cloudflared.mkdir(parents=True, exist_ok=True)
    asset = _asset_name(ctx)
    url = _find_asset_download(ctx, asset)
    tmp = ctx.paths.cloudflared / asset
    _download_file(ctx, url, tmp)

    if asset.endswith(".tgz"):
        import tarfile

        with tarfile.open(tmp, "r:gz") as tar:
            member = next((m for m in tar.getmembers() if Path(m.name).name == "cloudflared"), None)
            if member is None:
                raise RuntimeError("cloudflared archive did not contain the executable.")
            extracted = tar.extractfile(member)
            if extracted is None:
                raise RuntimeError("cloudflared executable could not be read from archive.")
            exe.write_bytes(extracted.read())
        tmp.unlink(missing_ok=True)
    else:
        tmp.replace(exe)

    if sys.platform != "win32":
        exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return exe


def _append_log(ctx: AppContext, line: str) -> None:
    if not line:
        return
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
    try:
        port = int(port)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid tunnel target port.") from exc
    if port < 1 or port > 65535:
        raise ValueError("Tunnel target port must be between 1 and 65535.")

    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        if proc is not None and proc.poll() is None:
            return ctx.state.remote_tunnel.snapshot()
        ctx.state.remote_tunnel.update(
            status="starting",
            url="",
            message="Starting Cloudflare tunnel...",
            log="",
        )
        try:
            exe = _ensure_cloudflared(ctx)
            args = [str(exe), "tunnel", "--url", f"http://127.0.0.1:{port}"]
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=str(ctx.paths.root),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
            )
        except (OSError, URLError, RuntimeError) as exc:
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
