"""sd-cli one-shot generation orchestration.

The core signature feature. See PLAN.md §10.

TODO(Phase 2):
- build_args(): turn a generation request + flag definitions into the sd-cli
  argv (mode, prompt, dimensions, steps, cfg, sampler, seed, batch, model
  component paths, backend/GPU flags, output + preview paths).
- run(): acquire ctx.state.generation_lock, spawn sd-cli via process_manager,
  stream stdout/stderr, parse step progress (regex over "step X/Y"), poll the
  --preview-path file mtime for the live preview, and on exit collect output
  image(s), write a JSON sidecar to output/.gallery/, set state=done.
- cancel(): set ctx.state.generation_cancel and kill the process.
"""

import re
from typing import Any

from ..context import AppContext

# Provisional; confirm exact phrasing against a real sd-cli run in Phase 2.
_STEP_RE = re.compile(r"step\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)


def parse_step_progress(output: str) -> tuple[int, int] | None:
    """Return (step, total) from the latest matching line, or None."""
    last: tuple[int, int] | None = None
    for line in output.splitlines():
        m = _STEP_RE.search(line)
        if m:
            last = (int(m.group(1)), int(m.group(2)))
    return last


def build_args(ctx: AppContext, request: dict[str, Any]) -> list[str]:
    # TODO(Phase 2): assemble sd-cli argv from request + shared flag defs.
    raise NotImplementedError


def run(ctx: AppContext, request: dict[str, Any]) -> dict[str, Any]:
    # TODO(Phase 2): orchestrate one sd-cli run, return {job_id}.
    raise NotImplementedError


def status(ctx: AppContext) -> dict[str, Any]:
    return ctx.state.generation.snapshot()


def cancel(ctx: AppContext) -> bool:
    # TODO(Phase 2): set cancel event + kill process.
    ctx.state.generation_cancel.set()
    return True
