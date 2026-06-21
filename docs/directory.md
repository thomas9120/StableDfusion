# StableDfusion — Directory Reference

> **Companion to `PLAN.md`.** This file tracks the *as-built* structure.
> `PLAN.md` is the design source of truth; this file reflects what's on disk.

## Root

| File | Role |
|---|---|
| `server.py` | Entry point — `python server.py` boots the backend on port 5250 |
| `config.json` | Persisted install state (active runtime + installed backend registry) |
| `install-windows.bat` | One-click Windows installer |
| `start-windows.bat` | One-click Windows launcher |
| `install.sh` | macOS/Linux installer |
| `start.sh` | macOS/Linux launcher |
| `requirements.txt` | Python dependencies (stdlib + optional `certifi`) |
| `pyproject.toml` | Ruff config |
| `pyrightconfig.json` | Pyright type-checking config |
| `package.json` | Node dev deps (Playwright for smoke tests) |
| `AGENTS.md` | Agent instructions and conventions |
| `PLAN.md` | Architecture design document (source of truth) |

## Backend (`backend/`)

| Module | Role | Status |
|---|---|---|
| `app.py` | HTTP handler, CORS, route registry, `_assemble_index()` partial system, `main()` | ✅ boots |
| `config.py` | Paths (`sdcpp/`, `output/`, `models/` component folders), ports (5250 / 1234), env (`SD_GUI_*`) | ✅ |
| `context.py` | `AppContext`, `AppPaths`, `ServerConfig`, `BackendServices` | ✅ |
| `state.py` | `ServerState` + `AtomicDict` + locks (generation, sd_server, model_download, tunnel) | ✅ |
| `http.py` | `Request`/`Response`/CORS helpers (generic) | ✅ |
| `routing.py` | `Router` (exact + prefix) | ✅ |

### Partial assembly

`app.py` contains `_assemble_index()` which reads `ui/index.html` (the shell) and
substitutes `<!-- @partial NAME -->` placeholders with the contents of
`ui/partials/NAME.html`. Partials are re-read on every request (no caching) so
edits reflect on browser refresh. Missing partials log a warning and leave the
placeholder intact. The `ui/partials/` directory is never served directly —
`is_static_ui_path()` in `http.py` only allows `/css/`, `/js/`, `/assets/` prefixes.

### Routes (`backend/routes/`) — wired in `app.py:API_ROUTER`

| Route | Method | Handler |
|---|---|---|
| `/api/status` | GET | `status.get_status` |
| `/api/releases` | GET | `install.get_releases` |
| `/api/download-progress` | GET | `install.get_download_progress` |
| `/api/models` | GET | `models.list_models` |
| `/api/images` | GET | `images.list_images` |
| `/api/generate/status` | GET | `generate.get_status` |
| `/api/generate/preview` | GET | `generate.get_preview` |
| `/api/hf/download-status` | GET | `hf_download.get_download_status` |
| `/api/sd-server/status` | GET | `server_mode.get_status` |
| `/api/remote-tunnel/status` | GET | `tunnel.get_status` |
| `/api/app-update-status` | GET | `git_update.get_status` |
| `/api/presets` | GET | `presets.list_presets` |
| `/api/install` | POST | `install.start_install` |
| `/api/update` | POST | `install.start_update` |
| `/api/cleanup-sdcpp` | POST | `install.cleanup_sdcpp` |
| `/api/sdcpp/active` | POST | `install.set_active_runtime` |
| `/api/sdcpp/repair` | POST | `install.repair_runtime` |
| `/api/sdcpp/update` | POST | `install.update_runtime` |
| `/api/sdcpp/remove` | POST | `install.remove_runtime` |
| `/api/generate` | POST | `generate.generate` |
| `/api/generate/cancel` | POST | `generate.cancel` |
| `/api/hf/repo-files` | POST | `hf_download.list_repo_files` |
| `/api/hf/download` | POST | `hf_download.start_download` |
| `/api/hf/download-cancel` | POST | `hf_download.cancel_download` |
| `/api/sd-server/start` | POST | `server_mode.start` |
| `/api/sd-server/stop` | POST | `server_mode.stop` |
| `/api/remote-tunnel/start` | POST | `tunnel.start` |
| `/api/remote-tunnel/stop` | POST | `tunnel.stop` |
| `/api/app-update` | POST | `git_update.start_update` |
| `/api/shutdown` | POST | `lifecycle.post_shutdown` |
| `/api/restart` | POST | `lifecycle.post_restart` |
| `/api/open-folder` | POST | `lifecycle.post_open_folder` |
| `/api/select-file` | POST | `file_picker.select_file` |
| `/api/presets` | POST | `presets.save_preset` |
| `/api/presets/shortcut` | POST | `presets.export_preset_shortcut` |
| `/api/image/{name}` | GET | `images.serve_image` (prefix) |
| `/api/presets/{name}` | DELETE | `presets.delete_preset` (prefix) |

### Services (`backend/services/`)

| Module | Role |
|---|---|
| `sdcpp_manager.py` | Backend specs, release asset matching, install/update orchestration |
| `process_manager.py` | Spawn/kill sd-cli and sd-server processes |
| `model_storage_service.py` | Model directory structure and file listing |
| `server_mode_service.py` | sd-server lifecycle and `/v1/*` proxy |
| `generate_service.py` | One-shot sd-cli generation |
| `hf_download_service.py` | HuggingFace repo file listing and download |
| `file_picker_service.py` | Native file/folder picker dialogs |
| `git_update_service.py` | Git auto-update for the app itself |
| `tunnel_service.py` | Cloudflare tunnel for remote access |
| `lifecycle_service.py` | Shutdown, restart, open-folder operations |

## Frontend (`ui/`)

### Shell and partials

`ui/index.html` is a ~160-line shell containing the `<head>`, sidebar nav, modal,
script tags, and `<!-- @partial NAME -->` placeholders. The tab panels live
in `ui/partials/`:

| Partial | Tab |
|---|---|
| `install.html` | Install / update sd-cli |
| `generate-image.html` | Image generation, image references, metadata inspection, shared generation workbench |
| `generate-video.html` | Video generation tab host |
| `upscale.html` | Upscale tab host |
| `convert.html` | Convert tab host |
| `configure.html` | Full flag editor with search, collapse/expand, command preview |
| `server.html` | sd-server mode and API docs |
| `hf-download.html` | HuggingFace model downloader |
| `presets.html` | Save/load/export flag presets |

### JavaScript (`ui/js/`)

Script load order is fixed in `index.html` (see `PLAN.md` §8). `app.js` does
tab switching + status polling; other modules attach to `window.SDGui.*`.

| Module | Role |
|---|---|
| `app.js` | Tab switching, status polling, init orchestration |
| `manager.js` | Process state, sidebar status badge |
| `flag-core.js` | Shared flag state (`window.SDGui.flagCore`), `setFlagValue`, `getLaunchArgs` |
| `flag-validation.js` | Flag value validation and coercion |
| `config-flags-ui.js` | Configure tab: search/filter, category collapse, command preview, expand/collapse-all buttons |
| `generate-ui.js` | Generate coordinator: section routing, helper-module initialization, public methods used by app/presets/HF download |
| `gallery-rendering.js` | Image gallery rendering helpers |
| `hf-download-ui.js` | HF Download tab UI |
| `server-ui.js` | Server tab UI |
| `api-tab.js` | API documentation tab |
| `remote-tunnel-ui.js` | Remote tunnel status and controls |
| `presets.js` | Presets save/load/export |
| `app-data.js` | Shared app data helpers |

#### Generate subsystem (`ui/js/generate/`)

The Generate tab is split into focused global modules loaded before
`generate-ui.js`. Each module attaches to `window.SDGui.*`; there are no ES
modules or bundler assumptions.

| Module | Namespace | Role |
|---|---|---|
| `dom.js` | `window.SDGui.generateDom` | Shared safe DOM helpers (`$`, `el`, `setHidden`, `populateEnum`) |
| `formatters.js` | `window.SDGui.generateFormatters` | Pure formatting helpers for elapsed time, relative history time, and LoRA path/tag formatting |
| `dimensions.js` | `window.SDGui.generateDimensions` | Dimension shape/size widget, width/height swap, snapping, and live readout |
| `control-bindings.js` | `window.SDGui.generateControls` | Shared control registry, mirror controls, and flagCore-backed binding/sync helpers |
| `model-fields.js` | `window.SDGui.generateModelFields` | Bundle-driven model component pickers, model file list population, Browse actions, and LoRA controls |
| `history.js` | `window.SDGui.generateHistory` | LocalStorage history schema, render/restore/open/delete/clear actions, and history toolbar |
| `preview-progress.js` | `window.SDGui.generatePreviewProgress` | Live preview image/video switching, progress bar, ETA/elapsed text, and empty result placeholder |
| `results.js` | `window.SDGui.generateResults` | Result rendering, metadata text output, warnings/stderr display, result actions, and history entry creation |
| `run-controller.js` | `window.SDGui.generateRunController` | Generate request body construction, LoRA prompt injection, polling, cancellation, metadata inspect, and reload-time polling resume |

`generate-ui.js` remains the public coordinator. Its stable public surface is
`init`, `renderBundleFields`, `generate`, `cancel`, `renderHistory`,
`updateModeSections`, `syncFromState`, and `handleSectionChange`.

#### Flags subsystem (`ui/js/flags/`)

| Module | Role |
|---|---|
| `definitions.js` | Single source of truth for all sd-cli/sd-server flags |
| `categories.js` | Flag category groupings |
| `options.js` | Enum option lists for flags |
| `model-bundles.js` | Multi-file model bundle definitions (diffusion + VAE + text-encoder + LoRA) |
| `helpers.js` | Flag lookup helpers (`getFlagsByCategory`, etc.) |

### CSS (`ui/css/`)

| File | Role |
|---|---|
| `tokens.css` | Design tokens (colors, spacing, typography, radii) |
| `style.css` | Component styles, layout, buttons, forms, modals |

## Runtime directories

Created on boot by `backend/app.main()`: `models/`, `models/diffusion/`,
`models/vae/`, `models/text-encoders/`, `models/loras/`, `presets/`,
`sdcpp/bin/` (legacy/current fallback), `sdcpp/installs/`, `output/`,
`output/.preview/`, `output/.gallery/`.

New stable-diffusion.cpp installs are stored by runtime under
`sdcpp/installs/<tag>/<backend>/bin/`. The active runtime recorded in
`config.json` is the one used by one-shot generation and `sd-server`.

## Tests (`tests/`)

| Directory | Contents |
|---|---|
| `tests/backend/` | pytest unit tests for routes, services, and managers |
| `tests/frontend/` | Playwright smoke tests (dev only) |

## Tooling

- Python: `ruff` (config in `pyproject.toml`), `pyrightconfig.json`.
- Node: `playwright` (dev only) for frontend smoke tests (`tests/frontend/`).
