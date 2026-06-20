"""Server lifecycle: shutdown, restart, cleanup, open-folder.

~Verbatim from LLama-GUI's lifecycle.py (generic). On shutdown/restart we first
stop the running sd-cli/sd-server process and the Cloudflare tunnel so ports
and subprocesses don't leak.
"""

import os
import socket
import subprocess
import sys
import threading
import time

from .. import config
from ..context import AppContext


def stop_runtime_services(ctx: AppContext) -> None:
    """Stop any running sd-cli/sd-server process + cloudflared tunnel."""
    from . import process_manager, server_mode_service, tunnel_service

    try:
        tunnel_service.stop_remote_tunnel(ctx)
    except Exception as exc:
        print(f"[lifecycle] tunnel stop error: {exc}", file=sys.stderr)
    try:
        server_mode_service.stop(ctx)
    except Exception as exc:
        print(f"[lifecycle] sd-server stop error: {exc}", file=sys.stderr)
    try:
        process_manager.stop_process(ctx)
    except Exception as exc:
        print(f"[lifecycle] process stop error: {exc}", file=sys.stderr)


def shutdown_gui_server(ctx: AppContext) -> bool:
    """Schedule a graceful server shutdown (returns immediately)."""
    server = ctx.state.gui_server
    if server is None:
        return False
    stop_runtime_services(ctx)
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def cleanup_gui_server(ctx: AppContext) -> None:
    stop_runtime_services(ctx)
    server = ctx.state.gui_server
    if server is not None:
        try:
            server.server_close()
        except Exception:
            pass
        ctx.state.gui_server = None


def _wait_for_port_release(
    gui_host: str, gui_port: int, startup_delay: float, wait_attempts: int, wait_seconds: float
) -> bool:
    time.sleep(startup_delay)
    for i in range(wait_attempts):
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind((gui_host, gui_port))
            return True
        except OSError:
            if i < wait_attempts - 1:
                time.sleep(wait_seconds)
        finally:
            if sock is not None:
                sock.close()
    return False


def restart_gui_server(ctx: AppContext) -> bool:
    """Re-exec server.py in a detached child, then exit this process."""
    server = ctx.state.gui_server
    if server is None:
        return False

    stop_runtime_services(ctx)
    restart_script = str(ctx.paths.root / "server.py")
    gui_host = ctx.config.gui_host
    gui_port = ctx.config.gui_port

    def _restart() -> None:
        try:
            port_free = _wait_for_port_release(
                gui_host,
                gui_port,
                config.RESTART_STARTUP_DELAY_SECONDS,
                config.RESTART_PORT_WAIT_ATTEMPTS,
                config.RESTART_PORT_WAIT_SECONDS,
            )
            if not port_free:
                print(
                    f"WARNING: Port {gui_port} still in use after waiting; "
                    "attempting restart anyway",
                    file=sys.stderr,
                )
            subprocess.Popen(
                [sys.executable, restart_script],
                cwd=str(ctx.paths.root),
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                if sys.platform == "win32"
                else 0,
            )
            print("Restarting StableDfusion...", file=sys.stderr)
        except Exception as exc:
            print(f"ERROR: Failed to restart server: {exc}", file=sys.stderr)
            import traceback

            traceback.print_exc()
            return
        os._exit(0)

    threading.Thread(target=_restart, daemon=False).start()
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def open_folder_in_file_manager(target) -> None:
    if sys.platform == "win32":
        os.startfile(str(target))  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.run(["open", str(target)], check=False)
        return
    subprocess.run(["xdg-open", str(target)], check=False)
