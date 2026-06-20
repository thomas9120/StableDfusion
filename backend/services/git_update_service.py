"""Git-based app auto-update. ~Verbatim from LLama-GUI (generic).

TODO(Phase 1): git fetch/pull/status, safe dirty-path classification, deps
reinstall, server restart. See PLAN.md §15 Phase 1.
"""

from ..context import AppContext


def get_status(ctx: AppContext, fetch: bool = False) -> dict:
    raise NotImplementedError


def start_update(ctx: AppContext) -> dict:
    raise NotImplementedError
