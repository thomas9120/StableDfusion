# AGENTS.md

## Project Reference

The full design lives in **`PLAN.md`** (architecture, directory map, tab design,
backend/frontend module reference, the Generate flow, install/release
management, model bundles, phased roadmap, open decisions, testing).

Read `PLAN.md` before starting any task.

## Relationship to LLama-GUI

This project mirrors **LLama-GUI**'s architecture (Python stdlib HTTP server +
vanilla JS frontend). Reuse LLama-GUI's proven patterns for: HTTP/CORS/SSE
helpers, routing, threading state, file picker, Cloudflare tunnel, git
auto-update, and presets. **Do not modify LLama-GUI files** — it is a reference
only.

## What's different (the gotchas)

- **sd-cli is one-shot**, not a persistent server. The primary loop is
  Generate → run once → show image → history. Don't model it like llama-server.
- **Models are multi-file.** Drive file-picker visibility with model-type
  bundles (`ui/js/flags/model-bundles.js`), not a single model select.
- **Releases are continuous builds.** Match assets by **suffix pattern** against
  each release's `assets[]`; never build asset names from the tag.
- **No chat / benchmarking / web search / metrics / chat templates.** Don't port
  those modules.

## UI State Sync Rule (carried over from LLama-GUI)

When a setting appears in more than one place (e.g. dimensions or seed in both
Generate and Configure), all instances read from the same `window.SDGui.flagCore`
state and route writes through one shared setter (`setFlagValue`). Command
preview / launch args derive only from shared state. Never mutate `flagValues`
directly.

## Verify After Every Change

- `node --check ui/js/<file>.js` on every JS file you touch.
- `ruff check . && ruff format .` for Python.
- `python server.py` then `curl http://127.0.0.1:5250/api/status` to confirm the
  backend boots.
- Serve `ui/` as the web root for browser smoke checks (root-relative `/js/...`
  assets require it).

## Frontend Pitfalls

- **No `innerHTML` with dynamic content.** Use `textContent`, `createElement`,
  `replaceChildren`, or `new Option`. (The slop rule blocks `innerHTML`.)
- Attach new behavior under `window.SDGui.<module>` namespaces, not as globals.

## Backend Pitfalls

- All stateful operations (generation, install, HF download, tunnel, sd-server)
  use locks in `backend/state.py`. Acquire the right lock before mutating.
- Validate all external input (HF repo ids, filenames, user paths) with strict
  regex + path-traversal checks.
- Routes return sanitized errors via `Response.error()`; real details go to
  stderr via `print()`.

## Service module naming

Service modules that would share a basename with a route module use a `_service`
suffix (`generate_service`, `hf_download_service`, `tunnel_service`,
`lifecycle_service`, `file_picker_service`, `git_update_service`) to avoid a
basename collision between a route and the service it imports. `sdcpp_manager`
and `process_manager` keep `_manager` (they already differ from any route name).

## Flag system

`ui/js/flags/definitions.js` is the single source of truth for `sd-cli` /
`sd-server` flags. Before adding/changing a flag, verify it against the current
upstream (`sd-cli -h` and `examples/common/common.cpp`).
