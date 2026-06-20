"""Cloudflare tunnel lifecycle. ~Verbatim from LLama-GUI (generic).

TODO(Phase 5): auto-download cloudflared to ctx.paths.cloudflared, run
``cloudflared tunnel --url <port>``, scrape the trycloudflare.com URL from
stderr, thread-safe start/stop + status polling.
"""

from ..context import AppContext


def start(ctx: AppContext, port: int) -> dict:
    raise NotImplementedError


def stop(ctx: AppContext) -> bool:
    raise NotImplementedError


def get_snapshot(ctx: AppContext) -> dict:
    return ctx.state.remote_tunnel.snapshot()
