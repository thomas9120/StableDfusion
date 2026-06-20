# Stable-D GUI — Directory Reference

> **Companion to `PLAN.md`.** This file tracks the *as-built* structure.
> `PLAN.md` is the design source of truth; this file reflects what's on disk.

## Backend (`backend/`)

| Module | Role | Status |
|---|---|---|
| `app.py` | HTTP handler, CORS, route registry, `main()` | ✅ boots |
| `config.py` | Paths (`sdcpp/`, `output/`, `models/`), ports (5250 / 1234), env (`SD_GUI_*`) | ✅ |
| `context.py` | `AppContext`, `AppPaths`, `ServerConfig`, `BackendServices` | ✅ |
| `state.py` | `ServerState` + `AtomicDict` + locks (generation, sd_server, model_download, tunnel) | ✅ |
| `http.py` | `Request`/`Response`/CORS helpers (generic) | ✅ |
| `routing.py` | `Router` (exact + prefix) | ✅ |

### Routes (`backend/routes/`) — wired in `app.py:API_ROUTER`

Most return 501 TODOs until their phase. Functional now: `status.get_status`,
`models.list_models`, `images.list_images`.

### Services (`backend/services/`)

`sdcpp_manager`, `process_manager` (indexed); `*_service` modules are stubs that
`raise NotImplementedError`. See `PLAN.md` §7 and AGENTS.md "Service module
naming".

## Frontend (`ui/`)

Script load order is fixed in `index.html` (see `PLAN.md` §8). `app.js` does
tab switching + status polling; other modules are namespace stubs awaiting their
phase.

## Runtime directories

Created on boot by `backend/app.main()`: `models/`, `presets/`, `sdcpp/bin/`,
`output/`, `output/.preview/`, `output/.gallery/`.

## Tooling

- Python: `ruff` (config in `pyproject.toml`), `pyrightconfig.json`.
- Node: `playwright` (dev only) for frontend smoke tests (`tests/frontend/`).
