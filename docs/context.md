# StableDfusion — README Rewrite Context

A desktop web GUI for **`leejet/stable-diffusion.cpp`** (`sd-cli` one-shot + `sd-server` persistent),
modeled on the sibling **LLama-GUI** project (Python stdlib HTTP server + vanilla JS, no framework, no bundler).

---

## 1. Architecture at a Glance

```
python server.py  →  backend.app.main()
                      └─ http.server.ThreadingHTTPServer (bind SD_GUI_HOST:SD_GUI_PORT, default 127.0.0.1:5250)
                         └─ Handler (backend/app.py)
                             ├─ static  : serves ui/  as web root  (SimpleHTTPRequestHandler, directory=UI_DIR)
                             ├─ /       : _assemble_index() → ui/index.html with <!-- @partial NAME --> inlined
                             ├─ /api/*  : API_ROUTER (backend/routing.py) dispatch → backend/routes/*.py
                             └─ /v1, /sdapi, /sdcpp/* : transparent proxy → running sd-server (127.0.0.1:1234)
```

- **No framework.** `http.server` + hand-written `Router`, `Request`/`Response` wrappers.
- **No JS bundler.** Scripts loaded in fixed order in `ui/index.html`; each attaches to `window.SDGui.*`.
- **Frontend sync rule:** all UI state lives in `window.SDGui.flagCore`; writes go through `setFlagValue()`. Configure + Generate tabs read the same shared state.
- **Stdlib + 2 deps:** `certifi` (SSL bundle), `huggingface_hub` (model downloads). Pillow is *intentionally* not a dep — thumbnails are client-side scaled full images.

### Backend ↔ sd-cli / sd-server

| Tool | Role | Lifespan | Driver |
|---|---|---|---|
| `sd-cli` | One-shot generate/upscale/convert/metadata | Per request (POST `/api/generate`) | `generate_service.run()` → `process_manager.launch_process()` |
| `sd-server` | Persistent OpenAI/SDAPI server | Started/stopped from Server tab | `server_mode_service.start()` (own process + lock, independent of generator) |

Both binaries live in `sdcpp/bin/`. `process_manager._build_process_env()` prepends `sdcpp/bin` to `PATH` (+`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`) so shared libs resolve. Binaries resolved via `find_tool_executable(tool)` = `sdcpp/bin/<tool>[.exe]`.

---

## 2. Entry Points & Setup

### Launch

- **`server.py`** (3 lines) → `backend.app.main()`. Run with `python server.py`.
- **Launchers:** `start.sh` / `start-windows.bat` (open browser, run server.py, prefer `.venv`).
- **Installers:** `install.sh` / `install-windows.bat` (create `.venv`, `pip install -r requirements.txt`, optional `npm install`).

### Requirements

- **Python ≥ 3.11** (`pyproject.toml` `requires-python`; verified by install scripts).
- **`requirements.txt`:** `certifi>=2026.5.20`, `huggingface_hub>=0.24.0`.
- **Node:** optional dev-only — `playwright` for `tests/frontend/` smoke tests; JS lint via `node --check`.

### Environment variables (`backend/config.py`)

| Env | Default | Purpose |
|---|---|---|
| `SD_GUI_HOST` | `127.0.0.1` | GUI bind host (`0.0.0.0` / `*` for LAN; `*` trusts the request `Host` header origin) |
| `SD_GUI_PORT` | `5250` | GUI port (distinct from LLama-GUI's 5240 so both run together) |
| `SD_GUI_ALLOWED_HOSTS` | — | Comma-separated extra allowed hosts (LAN IPs / hostnames), admitted as `http://<host>:<port>` origins |
| `SD_GUI_PROXY_TIMEOUT` | `1800` | Timeout (seconds) per proxied `/v1` / `/sdapi` / `/sdcpp` request to sd-server |

`sd-server` internal defaults: host `127.0.0.1`, port `1234` (overridable from the Server tab).

### Runtime directories (created by `main()` on boot)

`models/{diffusion,vae,text-encoders,loras,upscalers}`, `presets/`, `sdcpp/bin/`, `output/`, `output/.preview/`, `output/.gallery/`.

### Install tab workflow

1. `GET /api/releases` → GitHub releases list for `leejet/stable-diffusion.cpp` (60s in-memory cache; `?force=1` bypasses).
2. User picks a **version** (tag) and **backend** variant (from `GET /api/status` → `available_backends`, platform-specific).
3. `POST /api/install {tag, backend}` → `sdcpp_manager.install_release()`:
   - Matches the backend's `asset_pattern` glob against the release's `assets[]` (continuous builds — tag is `master-<n>-<sha>`, never used to build asset names).
   - Downloads the main zip + optional **companion** (e.g. `cudart-sd-bin-win-cu12-x64.zip` for CUDA 12).
   - Extracts **flat** into `sdcpp/bin/` (wiped first; `.gitkeep` preserved).
   - No SHA verification (upstream ships none) — logs a stderr warning.
4. `GET /api/download-progress` polled by the UI; on success writes `config.json {version, backend, tag}`.

- **Update** (`POST /api/update`) compares installed tag vs latest release[0].tag_name.
- **Repair** triggers when `validate_runtime_dependencies()` finds missing macOS `@rpath` dylibs (`otool -L`).
- **Remove Binaries** (`POST /api/cleanup-sdcpp`) deletes `sdcpp/`, resets config — preserves models/output/presets.

### Backend variants (`sdcpp_manager.build_backend_specs`)

- **Windows x64:** `cpu-avx2` (default/recommended), `cpu-avx`, `cpu-avx512`, `cpu-noavx`, `cuda12` (+companion cudart), `vulkan`, `rocm-7.1.1`, `rocm-7.13.0`.
- **Linux x64:** `cpu` (recommended), `vulkan`, `rocm-7.2.1`, `rocm-7.13.0` (Ubuntu 24.04 assets).
- **macOS arm64:** `metal` (Apple Silicon).

---

## 3. Backend Structure (`backend/`)

| File | Role |
|---|---|
| `app.py` | HTTP `Handler`, CORS/preflight, route registry `API_ROUTER`, `_assemble_index()` partial inlining, `main()` boot, `configure_services()` |
| `config.py` | Path/URL/port constants; `SD_GUI_*` env parsing |
| `context.py` | `AppContext` (paths/config/state/services) — single shared context passed to every route handler |
| `state.py` | `ServerState` dataclass + `AtomicDict`; per-concern locks (process, install, generation, model_download, remote_tunnel, sd_server, preset) |
| `http.py` | `Request`/`Response`, CORS/origin validation, `sanitize_error()`, `is_v1_proxy_path()` (matches `/v1`, `/sdapi`, `/sdcpp`) |
| `routing.py` | `Router` — exact + prefix (`/api/presets/{name}`) matching |

### Routes (`backend/routes/`) — 33 entries wired in `app.py:API_ROUTER`

| Endpoint | Method | Handler |
|---|---|---|
| `/api/status` | GET | `status.get_status` — install state, exec presence, runtime health, platform/arch, available backends, paths |
| `/api/releases` | GET | `install.get_releases` (`?force=1`) |
| `/api/download-progress` | GET | `install.get_download_progress` |
| `/api/models` | GET | `models.list_models` (`?type=<purpose>` filters by component exts) |
| `/api/images` | GET | `images.list_images` — gallery sidecars (newest first) |
| `/api/image/{name}` | GET (prefix) | `images.serve_image` (`/thumbnail` returns full image) |
| `/api/generate` | POST | `generate.generate` — start job → `{job_id}` |
| `/api/generate/status` | GET | `generate.get_status` — `{state, step, total_steps, percent, preview_mtime, result_files, ...}` |
| `/api/generate/preview` | GET | `generate.get_preview` — preview PNG/WebM bytes (mode-dependent) |
| `/api/generate/cancel` | POST | `generate.cancel` |
| `/api/hf/repo-files` | POST | `hf_download.list_repo_files` |
| `/api/hf/download` | POST | `hf_download.start_download` |
| `/api/hf/download-status` | GET | `hf_download.get_download_status` |
| `/api/hf/download-cancel` | POST | `hf_download.cancel_download` |
| `/api/sd-server/start` | POST | `server_mode.start` |
| `/api/sd-server/stop` | POST | `server_mode.stop` |
| `/api/sd-server/status` | GET | `server_mode.get_status` |
| `/api/remote-tunnel/start` | POST | `tunnel.start` (`{port}`) |
| `/api/remote-tunnel/stop` | POST | `tunnel.stop` |
| `/api/remote-tunnel/status` | GET | `tunnel.get_status` |
| `/api/app-update-status` | GET | `git_update.get_status` (`?fetch=true`) |
| `/api/app-update` | POST | `git_update.start_update` |
| `/api/presets` | GET / POST | `presets.list_presets` / `presets.save_preset` |
| `/api/presets/{name}` | DELETE (prefix) | `presets.delete_preset` |
| `/api/presets/shortcut` | POST | `presets.export_preset_shortcut` |
| `/api/install` | POST | `install.start_install` `{tag, backend}` |
| `/api/update` | POST | `install.start_update` |
| `/api/cleanup-sdcpp` | POST | `install.cleanup_sdcpp` |
| `/api/shutdown` | POST | `lifecycle.post_shutdown` |
| `/api/restart` | POST | `lifecycle.post_restart` (re-execs server.py detached) |
| `/api/open-folder` | POST | `lifecycle.post_open_folder` (`folder ∈ {models,output,sdcpp,presets,root}`) |
| `/api/select-file` | POST | `file_picker.select_file` `{purpose}` (tkinter/osascript) |
| `/api/select-directory` | POST | `file_picker.select_directory` |

**Proxy passthrough** (not in API_ROUTER — handled in `Handler.do_*`): `GET/POST/PUT/PATCH/DELETE` on `/v1/*`, `/sdapi/*`, `/sdcpp/*` → `server_mode_service.proxy()` → running sd-server. Refuses (503) when sd-server not running.

### Services (`backend/services/`)

| Module | Role |
|---|---|
| `sdcpp_manager.py` | Backend specs, GitHub release fetch/cache, asset glob matching, zip extraction, install/update/remove, `validate_runtime_dependencies()` (macOS `otool -L` aware) |
| `process_manager.py` | `launch_process(tool, args)` (one at a time via `process_lock`), `stop_process()`, env/PATH/LD/DYLD injection, stdout/stderr streaming |
| `generate_service.py` | One-shot sd-cli orchestration: `build_argv()`, job worker, step-progress parsing, gallery sidecar writing |
| `server_mode_service.py` | sd-server lifecycle + curated flag whitelist + `/v1/*` HTTP proxy |
| `model_storage_service.py` | `models/` component folder mapping (purpose→subdir), legacy path rewriting |
| `file_picker_service.py` | Native picker (tkinter Win/Linux, osascript macOS) + `PURPOSE_FILTERS` ext lists |
| `hf_download_service.py` | HfApi repo listing + multi-file streaming download; strict regex validation |
| `tunnel_service.py` | Auto-downloads `cloudflared` per-platform, parses `*.trycloudflare.com` URL |
| `git_update_service.py` | `git fetch`/`status`/`pull --ff-only`, safe-dirty-path classification, `pip install -r requirements.txt` after pull |
| `lifecycle_service.py` | `shutdown_gui_server`, `restart_gui_server` (detached re-exec), `open_folder_in_file_manager` |

---

## 4. Frontend Structure (`ui/`)

### Shell + partials

`ui/index.html` (~165 lines) holds `<head>`, sidebar nav, confirm modal, and `<!-- @partial NAME -->` placeholders + a **fixed script-load order**. `app.py:_assemble_index()` inlines `ui/partials/NAME.html` per request (no caching). `ui/partials/` is never served directly.

**9 tabs** (sidebar sections; switching via `app.js:switchSection`, persisted in `localStorage`):

| Section | Partial | Group |
|---|---|---|
| Install | `install.html` | Setup |
| Generate Image | `generate-image.html` | Setup |
| Generate Video | `generate-video.html` | Setup |
| Upscale | `upscale.html` | Setup |
| Convert | `convert.html` | Setup |
| Configure | `configure.html` | Setup |
| Server & API | `server.html` | Serve |
| HF Download | `hf-download.html` | Manage |
| Presets | `presets.html` | Manage |

`generate-image`, `generate-video`, `upscale`, `convert` all share one Generate workbench (`data-generate-host`) — `generate-ui.js` wires each host to `flagCore` with a different mode.

### JS modules (`ui/js/`) — all `window.SDGui.*`

- **State core:** `flag-core.js` (`flagCore`: mode/bundle/flagValues, `setFlagValue`, `getLaunchArgs`), `flag-validation.js`, `app-data.js`.
- **Flags subsystem (`ui/js/flags/`):** `definitions.js` (**single source of truth** for all sd-cli/sd-server flags, audited vs `sd-cli -h`), `categories.js`, `options.js` (enum lists), `model-bundles.js` (multi-file model-type presets), `helpers.js`.
- **Generate subsystem (`ui/js/generate/`):** `dom.js`, `formatters.js`, `dimensions.js` (aspect-ratio/size widget), `control-bindings.js`, `model-fields.js` (bundle-driven pickers), `history.js` (localStorage history), `preview-progress.js`, `results.js`, `run-controller.js` (request body build + polling).
- **Coordinators:** `generate-ui.js` (public surface: `init`, `renderBundleFields`, `generate`, `cancel`, `renderHistory`, `updateModeSections`, `syncFromState`, `handleSectionChange`), `config-flags-ui.js` (Configure tab: search/filter, collapse, command preview), `gallery-rendering.js`, `hf-download-ui.js`, `server-ui.js`, `api-tab.js` (endpoint docs), `remote-tunnel-ui.js`, `presets.js`, `manager.js`, `app.js` (init + tab switching + 5s status poll).

### CSS: `ui/css/tokens.css` (design tokens) + `ui/css/style.css`

---

## 5. Features (map to endpoints/services)

### Generate (primary) — `POST /api/generate`

sd-cli is **one-shot**. Request body: `{mode, args:[[flag,value],...], seed, total_steps, preview_method, params:{...}}`.

- **Modes** (`SD_MODES`): `img_gen`, `vid_gen`, `convert`, `upscale`, `metadata`.
- `generate_service.build_argv()` strips backend-owned flags (`-M`, `-o`, `--preview-path`) and injects its own (`-M <mode>`, `-o output/<ts>_<seed>.<ext>`, `--preview-path output/.preview/<...>`, `--preview <method>`).
- Worker thread streams output, parses step progress from `\r`-buffered sampling bars + polls `--preview-path` mtime for live preview.
- **Output ext per mode:** img_gen/upscale `.png`, vid_gen `.webm`, convert `.gguf`, metadata `.txt` (stdout-only, captured as `stdout_excerpt`).
- Result files matched by `<base_name>*`; per-file size sanity warnings (empty/<64B/<1KB PNG) written to sidecar.
- **Gallery sidecars:** `output/.gallery/<base_name>.json` (mode, bundle, prompt, seed, dims, all params, files, warnings, stderr_tail). Listed via `GET /api/images`.

### Model bundles (`ui/js/flags/model-bundles.js`) — drive file-picker fields

`sd1` (model), `sdxl` (model+vae), `sd3` (model+clip_l+clip_g+t5xxl), `flux1` (diffusion_model+vae+clip_l+t5xxl, all required), `flux2` (diffusion+vae+llm), `qwen_image` (diffusion+vae+llm), `wan` (diffusion+vae+llm, **defaults to vid_gen**), `ltx` (diffusion+vae+llm+embeddings_connectors, vid_gen), `z_image` (diffusion+vae+llm), `custom` (all fields). Each bundle applies suggested dims/steps/cfg/feature defaults.

### Server & API

- Start/stop `sd-server` (own process + `sd_server_lock`, coexists with a running generator).
- Curated server-flag whitelist (`CURATED_SERVER_VALUE_FLAGS` / `_BOOL_FLAGS`); extra free-form args via textarea (`_tokenize_extra`).
- **Proxy targets** (shown in API tab): OpenAI `/v1/images/generations`, SDAPI `/sdapi/v1/txt2img`, sdcpp `/sdcpp/v1/txt2img` — both via direct `127.0.0.1:1234` and via the GUI proxy origin.

### Cloudflare Tunnel — `POST /api/remote-tunnel/start {port}`

`tunnel_service` auto-downloads `cloudflared` (per-platform asset from `cloudflare/cloudflared` latest release; macOS gets `.tgz`), runs `cloudflared tunnel --url :<port>`, parses `*.trycloudflare.com` URL from stdout.

### HF Download — `POST /api/hf/repo-files` then `/api/hf/download`

Multi-file bundles (diffusion+vae+clip+t5xxl+llm). `huggingface_hub.HfApi` for listing; streaming `hf_hub_download`. Strict regex on repo id / filename / revision. Files auto-routed to `models/{diffusion,vae,text-encoders,loras,upscalers}` via `infer_subdir_for_filename()`.

### Convert / Upscale / Metadata

Separate tabs reusing the Generate workbench. `convert` → `.gguf` (sd-cli's convert target). `metadata` mode reads `--image`, no model required, prints to stdout (captured in sidecar). `upscale` needs `--upscale-model` + `--init-img`.

### Presets

`presets/*.json` (schema 1, `kind: stable-d-gui.preset`). Fields: name/description/bundle(=model_type)/mode/values. Export-as-shortcut (`POST /api/presets/shortcut` → `<name>.sdgui-preset.json`). Restore applies values back into `flagCore`.

### Git auto-update — `POST /api/app-update`

`git fetch` + `status --porcelain`, classifies dirty paths as safe (binary/model/log dirs, `.zip`, etc.) vs blocking; `git pull --ff-only` then `pip install -r requirements.txt`. Refuses on diverged/ahead/blocking-changes. Repo: `https://github.com/thomas9120/stable-d-gui.git` (marked TODO to set real repo).

### File picker (multi-file models)

`POST /api/select-file {purpose}` → native dialog filtered by `PURPOSE_FILTERS` (purpose→extensions+title). Used by Generate model-component pickers (driven by the active bundle's `fields`).

---

## 6. State & Concurrency (`backend/state.py`)

`ServerState` dataclass holds all runtime state, each concern guarded by its own `threading.Lock` (per AGENTS.md rule):

- `process` + `process_lock` (single sd-cli/sd-server slot, shared with generator)
- `generation` (AtomicDict) + `generation_lock` + `generation_cancel` (Event)
- `install` progress (AtomicDict) + `install_lock` + `install_in_progress`
- `model_download` (AtomicDict) + `model_download_lock` + `model_download_cancel`
- `remote_tunnel` (AtomicDict) + `remote_tunnel_lock` + `remote_tunnel_process`
- `sd_server` (AtomicDict) + `sd_server_lock` + `sd_server_log` + `sd_server_process` (**separate from generator** so both run together)
- `preset_lock`

`AtomicDict.update/replace/snapshot` are lock-protected and return copied snapshots.

---

## 7. Key Files to Open First

1. **`backend/app.py`** — the whole server: Handler, route table, `main()`, partial assembly.
2. **`backend/config.py`** — paths, ports, env vars (the "what/where" of config).
3. **`ui/index.html`** — tab inventory + script load order.
4. **`docs/directory.md`** — already-existing as-built reference (very close to this doc; **note: AGENTS.md says "directory.md" but it lives at `docs/directory.md`, not repo root**).
5. **`ui/js/flags/definitions.js`** — full flag surface (sd-cli + sd-server).
6. **`backend/services/generate_service.py`** — the signature feature's internals.

---

## 8. README currently documents (gaps to fill)

The current `README.md` has: tagline, "What it is" (two-mode launcher), an empty **Quick start** (no commands), empty **Layout**, a partial **Configuration** table (3 env vars only), and a Cloudflare-tunnel mention. **Missing:** install/run commands, full env-var list, endpoint reference, feature coverage, model-bundle list, sd-server API proxy explanation, directory layout, Python/Node requirements. `docs/directory.md` and this `context.md` are the source material for the rewrite.

---

## Residual notes / gotchas

- `APP_REPO_URL = "https://github.com/thomas9120/stable-d-gui.git"` has a `# TODO: set real repo` comment — verify before publishing.
- The two server tools (sd-cli one-shot vs sd-server persistent) intentionally use **separate locks** so a running server never blocks a generation.
- Thumbnails are deliberately full-image (no Pillow); gallery `<img>` scales client-side.
- Frontend has **no `innerHTML` with dynamic content** rule — uses `textContent`/`createElement`/`replaceChildren`.
- `validate_runtime_dependencies()` only inspects `@rpath` dylibs on macOS; on Win/Linux it trusts `PATH`/`LD_LIBRARY_PATH` injection at launch.
- `_assemble_index()` re-reads partials every request (no caching) — fine for desktop, edits reflect on refresh.
