"""Server lifecycle: shutdown, restart, cleanup. ~Verbatim from LLama-GUI."""

import socket
import time

from .. import config
from ..context import AppContext


def cleanup_gui_server(ctx: AppContext) -> None:
    server = ctx.state.gui_server
    if server is not None:
        try:
            server.server_close()
        except Exception:
            pass


def wait_for_port_close(host: str, port: int) -> None:
    for _ in range(config.RESTART_PORT_WAIT_ATTEMPTS):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.settimeout(0.5)
            sock.connect((host, port))
            sock.close()
            time.sleep(config.RESTART_PORT_WAIT_SECONDS)
        except OSError:
            return  # port is free
        finally:
            try:
                sock.close()
            except Exception:
                pass


def shutdown(ctx: AppContext) -> None:
    # TODO(Phase 1): stop any running sd-cli / sd-server / tunnel, then exit.
    cleanup_gui_server(ctx)
