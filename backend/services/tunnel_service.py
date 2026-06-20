"""Cloudflare tunnel lifecycle. ~Verbatim from LLama-GUI (generic).

Phase 1 status: only the read/stop surfaces are wired (the tunnel cannot be
running until Phase 5 implements ``start``). ``stop_remote_tunnel`` is a safe
no-op so lifecycle's shutdown/restart can call it unconditionally.
TODO(Phase 5): auto-download cloudflared to ctx.paths.cloudflared, run
``cloudflared tunnel --url <port>``, scrape the trycloudflare.com URL from
stderr, thread-safe start/stop + status polling.
"""

from ..context import AppContext


def start(ctx: AppContext, port: int) -> dict:
    raise NotImplementedError


def stop(ctx: AppContext) -> bool:
    return stop_remote_tunnel(ctx)


def stop_remote_tunnel(ctx: AppContext) -> bool:
    """Stop the cloudflared tunnel if running. No-op until Phase 5."""
    proc = ctx.state.remote_tunnel_process
    if proc is None:
        return False
    # Phase 5 will terminate/kill the process here.
    ctx.state.remote_tunnel_process = None
    ctx.state.remote_tunnel.update(status="idle", url="", message="Remote tunnel is not running.")
    return True


def get_snapshot(ctx: AppContext) -> dict:
    return ctx.state.remote_tunnel.snapshot()
