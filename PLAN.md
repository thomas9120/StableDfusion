# Stable-D GUI — Build Plan

> A desktop-friendly web GUI for [`leejet/stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp),
> modeled on the architecture of **LLama-GUI** (its sibling project for `llama.cpp`).
>
> **Decisions confirmed with the user:**
>
> - **Workflow:** Both — a gallery-based **Generate** tab that runs `sd-cli` one-shot per image **and** a persistent **Server** tab for `sd-server`.
> - **Scope:** Core first (Install + Generate txt2img/img2img + Configure + Presets + HF downloader), then expand.
> - **Deliverable this pass:** This plan document **plus** a scaffolded project skeleton.

---

## 1. Goals & non-goals

### Goals

- Provide the same "download a binary, pick a model, run it, see results" UX that LLama-GUI gives for `llama.cpp`, but for image/video generation via `stable-diffusion.cpp`.
- Reuse LLama-GUI's proven architecture verbatim where it is generic (HTTP server, routing, CORS, threading, file picker, tunnel, git update, presets).
- Make the **primary loop** (prompt → generate → view image → history) a first-class, polished in-app gallery experience.
- Expose `sd-server` as a persistent API endpoint option (with tunnel) for users who want OpenAI/SDAPI access.

### Non-goals (explicitly dropped from LLama-GUI's feature set)

- **Chat interface** — not applicable to image generation.
- **Benchmarking tab** — `sd-cli` has no `llama-bench` equivalent we want to expose in v1.
- **Web search / DuckDuckGo** — chat-only feature.
- **Metrics / Prometheus polling / KV cache stats** — `sd-cli` doesn't expose these; `sd-server` exposes its own `/metrics`, which we can optionally proxy later (v2).
- **Chat template presets / Jinja bundles** — replaced by SD "model type bundles" (see §9).

---

## 2. Why this is not a 1:1 port

LLama-GUI's core loop is **launch a long-running server → chat against it**. Stable-diffusion.cpp has **two** very different execution models, and the GUI must serve both:

| | `sd-cli` | `sd-server` |
|---|---|---|
| Lifetime | **One-shot**: run once per generation, write a file, exit | **Persistent**: HTTP server until stopped |
| Output | Image/video files on disk | HTTP responses (SDAPI / OpenAI-compatible) + embedded web UI |
| GUI analog | New — a **Generate / gallery** workflow (no LLama-GUI equivalent; Chat is the closest in shape but not in function) | LLama-GUI's **API / server** flow almost exactly |
| Progress | stdout step lines + a `--preview-path` image updated via callback | `/sdcpp/v1` async progress events (v2) |

Other key differences driving design:

1. **`sd-cli` has 5 modes** (`img_gen`, `vid_gen`, `convert`, `upscale`, `metadata`). The Generate tab must switch its visible controls per mode.
2. **Models are multi-file.** A single model often needs several files: `--diffusion-model` + `--vae` + `--clip_l` / `--clip_g` / `--t5xxl` / `--llm` text encoders, optionally `--taesd`, `--control-net`, `--esrgan`, LoRAs. (LLama-GUI picks one `.gguf`.) This calls for a **model-type bundle** concept.
3. **Releases are continuous builds** tagged `master-<n>-<commit>` (e.g. `master-709-92a3b73`), and asset names embed the commit hash (`sd-master-92a3b73-bin-win-cuda12-x64.zip`). We **cannot** build asset names from the tag the way LLama-GUI does (`llama-{tag}-bin-...`). We must **match assets by suffix pattern** against the release's asset list.
4. **Backend naming differs**: CPU variants are AVX-granular (`-avx`, `-avx2`, `-avx512`, `-noavx`), plus `cuda12`, `vulkan`, `rocm-7.1.1`, `rocm-7.13.0` (Win), and a companion `cudart-sd-bin-win-cu12-x64.zip` runtime (analogous to LLama-GUI's `cudart-llama-bin-...`).

---

## 3. What we keep / change / drop vs. LLama-GUI

| Concern | LLama-GUI | Stable-D GUI |
|---|---|---|
| Backend framework | Python stdlib `http.server` | **Keep** (identical) |
| HTTP / CORS / SSE helpers | `backend/http.py` | **Keep** (identical, generic) |
| Router | `backend/routing.py` | **Keep** (identical, generic) |
| State + `AtomicDict` + locks | `backend/state.py` | **Keep** pattern; add `generation` + `gallery` state slots |
| Context / paths / config | `backend/context.py`, `config.py` | **Adapt**: `sdcpp/` instead of `llama/`, add `output/` dir, new ports |
| Entry point | `server.py` → `backend.app` | **Keep** (identical pattern) |
| Release install | `llama_manager.py` (tag-based asset name) | **Rewrite** as `sdcpp_manager.py` (**pattern-based** asset matching) |
| Process mgmt | `process_manager.py` (launch/stream/stop) | **Keep** + extend with **generate orchestration** (`services/generate.py`) |
| HF download | GGUF-only filters | **Adapt** to `.safetensors` / `.ckpt` / `.gguf` / `.sft` and multi-file bundles |
| Tunnel / git update / lifecycle / file picker | generic | **Keep** (near-identical) |
| Chat route + web search + metrics + benchmarks | present | **Drop** |
| Frontend: chat / chat-rendering / benchmark / sampler-presets | present | **Drop** |
| Frontend: flags/definitions | llama flags | **Rewrite** as `sd-cli` + `sd-server` flags |
| Frontend: chat-templates | Jinja presets | **Drop** → replace with **model-type bundles** |

---

## 4. Architecture

- **Backend:** Python stdlib `http.server` (no framework). Serves static `ui/` and provides JSON/SSE API.
- **Frontend:** Vanilla HTML/CSS/JS, ordered global `<script>` tags (no bundler, no ES modules). Each module attaches to `window.SDGui`.
- **Entry point:** `python server.py` (thin compat wrapper) → `backend/app.py`.
- **GUI server:** `127.0.0.1:5250` by default (`SD_GUI_HOST` / `SD_GUI_PORT` override; chosen ≠ 5240 so it can run alongside LLama-GUI).
- **sd-server** (when used): runs separately, default port `1234` (matches upstream).
- **sd-cli** (when used): spawned one-shot per generation by the backend.
- **Dependencies:** `certifi` (SSL), `huggingface_hub` (model downloads). (`ddgs` web search is dropped.)
- **State persistence:** `config.json` (installed version, active backend, tag) + `output/` gallery JSON sidecars + localStorage history on the frontend.
- **Thread safety:** all stateful operations (generation process, install, HF download, tunnel, server-mode process) use threading locks.

---

## 5. Directory map

```
stable-d-gui/
├── server.py                  # entrypoint → backend.app (thin wrapper)
├── config.json                # installed version / backend / tag
├── requirements.txt           # certifi, huggingface_hub
├── package.json               # playwright devDep + test scripts
├── README.md
├── PLAN.md                    # this file
├── AGENTS.md                  # agent workflow rules (adapted)
├── .gitignore
├── backend/
│   ├── __init__.py
│   ├── app.py                 # HTTP handler, CORS, router registry, main()
│   ├── config.py              # paths, ports, env parsing
│   ├── context.py             # AppPaths / ServerConfig / ServerState / BackendServices
│   ├── state.py               # ServerState, AtomicDict
│   ├── http.py                # Request/Response/SseWriter, CORS  (generic, ~verbatim)
│   ├── routing.py             # Router  (generic, ~verbatim)
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── status.py          # GET  /api/status
│   │   ├── install.py         # /api/releases, /api/install, /api/update, /api/download-progress, /api/cleanup-sdcpp
│   │   ├── generate.py        # /api/generate, /api/generate/status, /api/generate/preview, /api/generate/cancel
│   │   ├── models.py          # GET /api/models  (list model component files by type)
│   │   ├── images.py          # /api/images, /api/image/<name>, /api/image/<name>/thumbnail
│   │   ├── presets.py         # /api/presets CRUD + shortcut export
│   │   ├── hf_download.py     # /api/hf/repo-files, /api/hf/download, /api/hf/download-status, /api/hf/download-cancel
│   │   ├── server_mode.py     # /api/sd-server/start, /stop, /status
│   │   ├── tunnel.py          # /api/remote-tunnel/start, /stop, /status
│   │   ├── git_update.py      # /api/app-update-status, /api/app-update
│   │   ├── lifecycle.py       # /api/shutdown, /api/restart, /api/open-folder
│   │   └── file_picker.py     # /api/select-file
│   └── services/
│       ├── __init__.py
│       ├── sdcpp_manager.py    # release fetch (pattern-based asset match), download, sha256 verify, extract
│       ├── process_manager.py  # subprocess launch/stream/stop (shared: sd-cli + sd-server)
│       ├── generate_service.py # sd-cli orchestration: build args, run, parse progress/preview, collect outputs, gallery sidecars
│       ├── hf_download_service.py  # HF repo listing + multi-format download w/ cancel
│       ├── tunnel_service.py       # cloudflared lifecycle
│       ├── git_update_service.py   # git fetch/pull/status + safe dirty-path classification
│       ├── lifecycle_service.py    # server shutdown/restart/cleanup
│       └── file_picker_service.py  # native tkinter file dialog
├── ui/
│   ├── index.html             # sidebar + 5 tab panels
│   ├── css/
│   │   ├── tokens.css         # theme tokens (dark; SD accent)
│   │   └── style.css          # layout + components
│   └── js/
│       ├── flags/
│       │   ├── options.js        # SAMPLING_METHODS, SCHEDULERS, WEIGHT_TYPES, PREVIEW_METHODS, RNG_TYPES, SD_MODES
│       │   ├── model-bundles.js  # MODEL_TYPE_BUNDLES (SD1.5 / SDXL / SD3 / FLUX / Qwen / Wan / Z-Image …)
│       │   ├── definitions.js    # SD_CLI_FLAGS + SD_SERVER_FLAGS  (single source of truth)
│       │   ├── categories.js     # FLAG_CATEGORIES
│       │   └── helpers.js        # getFlagsForMode(), getFlagsByCategory(), getBundleFields()
│       ├── flag-validation.js    # read-only validation of flag defs
│       ├── flag-core.js          # window.SDGui.flagCore — shared state, setters, getLaunchArgs()
│       ├── config-flags-ui.js    # window.SDGui.configFlagsUi — Configure tab
│       ├── manager.js            # window.SDGui.manager — releases/install/update + fetchJson()
│       ├── presets.js            # window.SDGui.presets — preset CRUD
│       ├── app-data.js           # QUICK_PROFILES, MODEL_TYPE list, generation defaults
│       ├── generate-ui.js        # window.SDGui.generateUi — PRIMARY Generate tab
│       ├── gallery-rendering.js  # window.SDGui.gallery — image/history DOM helpers
│       ├── hf-download-ui.js     # window.SDGui.hfDownloadUi — downloader UI
│       ├── server-ui.js          # window.SDGui.serverUi — persistent sd-server tab
│       ├── api-tab.js            # window.SDGui.apiTab — endpoint docs/snippets
│       ├── remote-tunnel-ui.js   # window.SDGui.remoteTunnelUi — tunnel UI
│       └── app.js                # window.SDGui — orchestration
├── docs/
│   ├── directory.md              # project reference (adapted)
│   ├── todo.md                   # phased roadmap checklist
│   └── cli_flags_report.md       # (later) sd-cli flag audit
├── tests/
│   ├── frontend/                 # node + playwright smoke tests
│   └── backend/                  # unittest
├── sdcpp/                        # downloaded binaries (sd-cli, sd-server + shared libs)
│   └── bin/
├── models/                       # user model files (.safetensors/.ckpt/.gguf/.sft)
├── output/                       # generated images/videos + thumbnails + JSON sidecars
├── presets/                      # saved preset JSON
├── tools/                        # auto-downloaded cloudflared
└── assets/                       # app icon/logo
```

---

## 6. Tabs (5 — consolidated for SD's single-task workflow)

LLama-GUI splits "launch config" and "chat" because they are genuinely separate activities. SD generation is one cohesive task, so we consolidate:

1. **Install** — download `stable-diffusion.cpp` releases, select backend, repair/remove, app updates. *(≈ LLama-GUI Install)*
2. **Generate** *(PRIMARY — landing tab)* — the gallery workflow. Mode selector, profile dropdown, prompt + negative prompt, core controls (dimensions, steps, cfg, sampler, scheduler, seed, batch), model-component file pickers (driven by the selected **model-type bundle**), backend/GPU toggles, **Generate** button, **live preview**, **result gallery**, and **history**. An "Advanced" expander surfaces more flags; a link opens Configure. *(Combines LLama-GUI Quick Launch + Chat, plus a brand-new gallery.)*
3. **Configure** — full `sd-cli` flag editor with search/filter and command preview, for power users. *(≈ LLama-GUI Configure)*
4. **Server & API** — launch `sd-server` persistently, view endpoint snippets (`/sdcpp/v1`, `/v1`, `/sdapi/v1`), start/stop Cloudflare tunnel. *(≈ LLama-GUI API tab)*
5. **Presets** — save/load/import/export generation configs grouped by model type. *(≈ LLama-GUI Presets)*

> **Sidebar runtime controls:** Unlike LLama-GUI (which has a global Launch/Stop for the server), the sidebar's primary action is contextual to the active tab: **Generate** on the Generate tab, **Start/Stop server** on the Server tab. We keep a global process-state badge.

---

## 7. Backend module reference

### Core (generic — ~verbatim from LLama-GUI)

| Module | Role |
|---|---|
| `backend/app.py` | HTTP handler, CORS, static serving, route registry, asset cache-busting, `main()` |
| `backend/config.py` | Paths (`SDCPP_DIR`, `OUTPUT_DIR`, `MODELS_DIR`, `PRESETS_DIR`…), ports, env parsing |
| `backend/context.py` | `AppContext`, `AppPaths`, `ServerConfig`, `BackendServices` dataclasses |
| `backend/state.py` | `ServerState` + `AtomicDict` + locks (adds `generation`, `gallery`, `sd_server` state) |
| `backend/http.py` | `Request`/`Response`/`SseWriter`, `sanitize_error()`, CORS validation |
| `backend/routing.py` | `Router` (exact + prefix matching) |

### Routes (`backend/routes/`)

| Route | Endpoints |
|---|---|
| `status.py` | `GET /api/status` |
| `install.py` | `GET /api/releases`, `GET /api/download-progress`, `POST /api/install`, `POST /api/update`, `POST /api/cleanup-sdcpp` |
| `generate.py` | `POST /api/generate`, `GET /api/generate/status`, `GET /api/generate/preview`, `POST /api/generate/cancel` |
| `models.py` | `GET /api/models?type=…` — list model component files in `models/` |
| `images.py` | `GET /api/images`, `GET /api/image/<name>`, `GET /api/image/<name>/thumbnail` |
| `presets.py` | `GET /api/presets`, `POST /api/presets`, `DELETE /api/presets/<name>`, `POST /api/presets/shortcut` |
| `hf_download.py` | `POST /api/hf/repo-files`, `POST /api/hf/download`, `GET /api/hf/download-status`, `POST /api/hf/download-cancel` |
| `server_mode.py` | `POST /api/sd-server/start`, `POST /api/sd-server/stop`, `GET /api/sd-server/status` |
| `tunnel.py` | `POST /api/remote-tunnel/start`, `POST /api/remote-tunnel/stop`, `GET /api/remote-tunnel/status` |
| `git_update.py` | `GET /api/app-update-status`, `POST /api/app-update` |
| `lifecycle.py` | `POST /api/shutdown`, `POST /api/restart`, `POST /api/open-folder` |
| `file_picker.py` | `POST /api/select-file` |

### Services (`backend/services/`)

| Service | Role |
|---|---|
| `sdcpp_manager.py` | GitHub release fetch; **pattern-based asset matching** by backend variant; download; SHA256 verify (against per-release sha256sums); zip/tar extract into `sdcpp/bin` |
| `process_manager.py` | Subprocess launch/stream/stop (shared by `generate` and `server_mode`); env building (PATH + LD/DYLD for shared libs); Windows `CREATE_NEW_PROCESS_GROUP` |
| `generate_service.py` | **The core.** Build `sd-cli` args from request + flag defs; run one-shot; stream output; parse step progress from stdout; poll the `--preview-path` file mtime; on exit, collect output image(s), generate thumbnails, write JSON sidecars to `output/.gallery/`; support cancel |
| `hf_download_service.py` | HF repo listing (multi-format), download w/ cancel + path-traversal guards |
| `tunnel_service.py` | Cloudflared lifecycle (auto-download, start/stop, URL scrape) |
| `git_update_service.py` | Git fetch/pull/status, safe dirty-path classification, deps reinstall |
| `lifecycle_service.py` | Graceful shutdown/restart, port-availability polling |
| `file_picker_service.py` | Native tkinter file dialog with purpose-based filters (model/vae/clip/lora/esrgan/image) |

> **Naming convention:** service modules that share a basename with a route module
> (e.g. routes `generate.py` ↔ services) use a `_service` suffix to avoid a basename
collision (a real footgun: a route importing the same-named service confuses both
> static analysis and readers). `sdcpp_manager` / `process_manager` keep `_manager`
> because they already differ from any route basename.

---

## 8. Frontend module reference + script load order

Loaded as ordered global `<script>` tags in `ui/index.html`. **Do not reorder.**

1. `flags/options.js` — shared enum lists
2. `flags/model-bundles.js` — model-type bundle definitions
3. `flags/definitions.js` — `SD_CLI_FLAGS` + `SD_SERVER_FLAGS` (single source of truth)
4. `flags/categories.js` — `FLAG_CATEGORIES`
5. `flags/helpers.js` — `getFlagsForMode`, `getFlagsByCategory`, `getBundleFields`
6. `flag-validation.js` — startup validation
7. `flag-core.js` — `window.SDGui.flagCore` (shared state, setters, `getLaunchArgs()`, custom-args parser)
8. `config-flags-ui.js` — `window.SDGui.configFlagsUi` (Configure tab)
9. `manager.js` — `window.SDGui.manager` (releases/install/update + `fetchJson`)
10. `presets.js` — `window.SDGui.presets`
11. `app-data.js` — `QUICK_PROFILES`, model-type list, generation defaults
12. `generate-ui.js` — `window.SDGui.generateUi` (PRIMARY Generate tab)
13. `gallery-rendering.js` — `window.SDGui.gallery`
14. `hf-download-ui.js` — `window.SDGui.hfDownloadUi`
15. `server-ui.js` — `window.SDGui.serverUi`
16. `api-tab.js` — `window.SDGui.apiTab`
17. `remote-tunnel-ui.js` — `window.SDGui.remoteTunnelUi`
18. `app.js` — `window.SDGui` orchestration

**UI-state sync rule (carried over from LLama-GUI):** when a setting appears in more than one place (e.g. dimensions or seed in both Generate and Configure), all instances read from the same `flagCore` state and route writes through one shared setter. Command preview / launch args derive only from shared state.

---

## 9. Flag system & model-type bundles

### Flag definitions

`ui/js/flags/definitions.js` defines `SD_CLI_FLAGS` (and `SD_SERVER_FLAGS`). Each entry: `id`, `flag` (CLI name + short form), `category`, `type`, `label`, `desc`, `default`, and `mode` (which `sd-cli` modes it applies to: `img_gen`, `vid_gen`, `upscale`, `convert`, `metadata`, or `all`). Types mirror LLama-GUI: `bool`, `int`, `float`, `text`, `path`, `enum`, `multi_enum`.

> **Authoritative source for the flag set:** run `<sdcpp>/bin/sd-cli -h` against an installed build, and/or read `examples/common/common.cpp` → `SDContextParams::get_options()` + `SDGenerationParams::get_options()` (and `SDCliParams::get_options()` in `examples/cli/main.cpp`). Verify every flag against the current upstream before exposing it.

### Proposed categories

`model_components` (diffusion-model, vae, clip_l, clip_g, t5xxl, llm, taesd, esrgan, control-net, embeddings), `generation` (prompt, negative-prompt, width, height, steps, cfg-scale, seed, batch-count), `sampling` (sampling-method, scheduler, rng, custom-sigmas), `img2img` (init-image, end-image, mask, strength, control-image, control-strength), `lora` (lora-model-dir, lora, lora-weight, lora-apply-mode), `backend_gpu` (ngl/n-gpu-layers, threads, flash-attn, diffusion-fa, clip-on-cpu, vae-on-cpu, offload-to-cpu, backend, params-backend, max-vram), `video` (video-frames, fps, motion-scale, vace-strength), `output` (output, format, embed-metadata, preview, preview-path), `advanced` (type/wtype, tensor-type-rules, vae-tiling, force-sdxl-vae, chroma masks, qwen-image-zero-cond-t, …).

### Model-type bundles (replaces LLama-GUI chat-template presets)

SD's model files vary by architecture. `ui/js/flags/model-bundles.js` defines `MODEL_TYPE_BUNDLES` — one entry per architecture — that drives **which file-picker fields the Generate tab shows** and suggests sane defaults:

| Bundle | Required / typical files | Notes |
|---|---|---|
| **SD 1.x / 2.x** | `-m` model | single-file |
| **SDXL / SDXL-Turbo** | `-m` model, optional `--vae` | 1024×1024 default |
| **SD3 / SD3.5** | `-m` model, `--clip_l`, `--clip_g`, `--t5xxl`, `--clip-on-cpu` recommended | |
| **FLUX.1** | `--diffusion-model` (gguf), `--vae`, `--clip_l`, `--t5xxl` | cfg-scale ~1.0 |
| **FLUX.2** | `--diffusion-model`, `--vae`, `--llm` | |
| **Qwen-Image / Edit** | `--diffusion-model`, `--vae`, `--llm` (text encoder) | |
| **Wan2.1/2.2 (video)** | `--diffusion-model`, `--vae`, `--llm`/`--t5xxl`; mode `vid_gen` | |
| **Z-Image** | `--diffusion-model`, `--vae`, `--llm`, `--diffusion-fa`, `--offload-to-cpu` | |
| **Custom** | show all fields | escape hatch |

Selecting a bundle shows/hides the relevant file pickers and sets default dimensions/steps/cfg.

### Launch-args generation (`flagCore.getLaunchArgs()`)

Same contract as LLama-GUI: iterate flags filtered by mode → skip inert defaults → build `[flag, value]` pairs → parse + append custom args → append model/diffusion-model path → return `{args, error, warnings}`.

---

## 10. The Generate flow (core) — detailed

This is the project's signature feature and the main departure from LLama-GUI.

### Backend (`backend/services/generate.py`)

1. `POST /api/generate` receives: mode, prompt/negative-prompt, generation params, model-component paths, backend/GPU flags, output naming preference, a chosen model-type bundle.
2. Build the `sd-cli` arg list (same definitions as the frontend).
3. Choose outputs:
   - result → `output/<UTC timestamp>_<seed>.<ext>` (printf sequence if batch > 1)
   - preview → `output/.preview/<job_id>.png` (passed via `--preview-path` + `--preview vae|taesd`)
4. Acquire the **single generation slot** lock (one generation at a time, matching LLama-GUI's single-process model). Spawn `sd-cli` via `process_manager`.
5. Stream stdout/stderr into the output buffer. Parse progress from sd.cpp's step lines (e.g. `step X/Y`) → store `{state, step, total_steps, percent, message}`.
6. `GET /api/generate/preview` returns the current preview image bytes (cache-busted by mtime) for the live <img> in the UI.
7. On process exit:
   - collect the produced image file(s);
   - generate a thumbnail (downscale to ~256px; can use Pillow if available, else serve full and let the browser scale);
   - write a JSON sidecar `output/.gallery/<name>.json` with full params + seed + timestamp + file list;
   - set state → `done` with the result image URL(s).
8. `POST /api/generate/cancel` kills the running `sd-cli`.

### Frontend (`ui/js/generate-ui.js`)

1. Mode selector switches visible control groups (txt2img / img2img / upscale / convert / metadata / video).
2. Model-type bundle dropdown shows the right file pickers; each has a **Browse** button (`/api/select-file`) and reads from `models/` via `/api/models?type=…`.
3. **Generate** button → `POST /api/generate` → get `job_id`.
4. Poll `GET /api/generate/status` every ~500ms: update a progress bar + step counter + status text; on preview mtime change, refresh the `<img>` with a cache-busting query.
5. On `done`: load result image(s) into the **gallery grid**, push an entry into **history** (localStorage: prompt, params, thumbnail, timestamp), enable "Send to img2img" / "Use settings" / "Open file" actions.
6. **History** persists across sessions; clicking an entry restores its full settings into the form (like a one-shot preset).

### Progress parsing notes

- sd.cpp logs denoising steps to stdout; `generate.py` regex-extracts `step (\\d+)/(\\d+)` (verify exact phrasing against a real run during implementation).
- For video modes, `video_frames > 4` switches preview to an `.avi`; we display the latest decoded frame where possible and otherwise show a "encoding video…" state.

---

## 11. Install / release management (`sdcpp_manager.py`)

**Key difference from LLama-GUI:** release tags are `master-<n>-<commit>`, and asset names embed the commit short-hash (`sd-master-<commit>-bin-...`). We therefore **do not** construct asset names from the tag. Instead:

1. `GET /api/releases` → fetch the GitHub releases list (cache short-term).
2. For each release, expose its raw `assets[]`.
3. `build_backend_specs()` defines, per platform/arch, a **variant key → asset-name suffix pattern** + label + optional companion asset. Examples (Windows x64):
   - `cpu-avx` → suffix `-bin-win-avx-x64.zip`
   - `cpu-avx2` → `-bin-win-avx2-x64.zip`  *(default CPU choice)*
   - `cpu-avx512` → `-bin-win-avx512-x64.zip`
   - `cpu-noavx` → `-bin-win-noavx-x64.zip`
   - `cuda12` → `-bin-win-cuda12-x64.zip` + companion `cudart-sd-bin-win-cu12-x64.zip`
   - `vulkan` → `-bin-win-vulkan-x64.zip`
   - `rocm-7.1.1`, `rocm-7.13.0` → `-bin-win-rocm-<ver>-x64.zip`
   - Linux x64: `cpu` (`-bin-Linux-Ubuntu-24.04-x86_64.zip`), `vulkan`, `rocm-7.2.1`, `rocm-7.13.0`
   - macOS arm64: `metal` (`-bin-Darwin-macOS-*-arm64.zip`) — single asset
4. When installing: locate the asset whose name **ends with** the variant suffix; download; verify SHA256 (download the release's sha256sums file and match); extract into `sdcpp/bin/`. Save `config.json` = `{version, backend, tag}`.
5. Runtime-dependency check: both `sd-cli` and `sd-server` need their shared libs (`.dll`/`.so`/`.dylib`) on PATH; `process_manager._build_process_env()` prepends `sdcpp/bin` (mirrors LLama-GUI).
6. Repair = reinstall current tag/backend; Remove = `shutil.rmtree(sdcpp/)` and reset config.

---

## 12. Server mode (`sd-server`)

For users who want a persistent API / the embedded web UI:

- **Server & API** tab: **Start sd-server** builds args from a small dedicated flag set (`SD_SERVER_FLAGS`: `--diffusion-model`, `--vae`, `--llm`/encoders, `--listen-ip`, `--listen-port` default 1234, `--cfg-scale`, `--diffusion-fa`, `--offload-to-cpu`, `--ngl`, …) and runs it via `process_manager` in a **separate** state slot from the one-shot generator (so Generate still works).
- `GET /api/sd-server/status` reports running/pid/target URL.
- **API snippets** (`api-tab.js`) show how to call `/sdcpp/v1/...`, `/v1/...`, `/sdapi/v1/...` against the running target.
- Cloudflare tunnel (`remote-tunnel-ui.js`) works against the sd-server port exactly as in LLama-GUI.

---

## 13. Model management + HF downloader

- `/api/models?type=<diffusion|vae|clip_l|clip_g|t5xxl|llm|taesd|esrgan|control|lora|image>` lists matching files in `models/` (and optionally subfolders) with size + mtime.
- File picker (`/api/select-file`) opens a native dialog filtered by `purpose`.
- HF downloader (`hf-download.py` + `hf-download-ui.js`):
  - **Repo-files**: list files (any of `.safetensors`, `.ckpt`, `.pth`, `.gguf`, `.sft`, `.bin`) and let the user pick **multiple** components in one session (diffusion model + vae + clip + t5xxl …), unlike LLama-GUI's single-model + single-mmproj flow.
  - Download with cancel, progress, overwrite prompt, partial-file cleanup, strict repo-id/filename/path-traversal validation.
  - On completion, auto-populate the matching Generate file pickers.

---

## 14. Branding, ports, paths

| | Value |
|---|---|
| Display name | **Stable-D GUI** |
| Env prefix | `SD_GUI_HOST`, `SD_GUI_PORT`, `SD_GUI_ALLOWED_HOSTS` |
| GUI port | `5250` (default) |
| sd-server port | `1234` (upstream default) |
| Binary dir | `sdcpp/bin/` (`sd-cli`, `sd-server` + shared libs) |
| Models dir | `models/` |
| Output dir | `output/` (+ `output/.preview/`, `output/.gallery/` for sidecars/thumbnails) |
| Presets dir | `presets/` |
| Tools dir | `tools/cloudflared/` |
| Logo / favicon | new SD-themed asset (image/palette icon), Tokyo-night-ish dark theme retained |

---

## 15. Phased roadmap

### Phase 0 — Scaffold ✅ (this pass)

Directory structure, bootable `server.py` + `backend/app.py` serving a placeholder UI, generic core (`config/context/state/http/routing`), stubbed routes/services with TODOs, stub frontend modules with `window.SDGui` namespaces, `PLAN.md`, `AGENTS.md`, `README.md`, `requirements.txt`, `package.json`, `.gitignore`.

### Phase 1 — Install + backend core ✅

- `sdcpp_manager.py`: real release fetch (60s cache) + **glob-pattern asset matching** (not tag-derived) + streaming download + flat zip extract + CUDA companion asset + `remove_sdcpp_files` + macOS `validate_runtime_dependencies`.
- `process_manager.py`: launch/stream/stop + shared-lib env builder (PATH/LD/DYLD prepend) + Windows `CREATE_NEW_PROCESS_GROUP` — core plumbing reused by Phase 2/5.
- `install.py` + `status.py` + `lifecycle.py` routes, `manager.js` UI (release/backend select, install/update/repair/remove, progress polling, installed-info, folders, maintenance, app-update).
- `/api/select-file` (tkinter + osascript, 12 SD-purpose filters), lifecycle (shutdown/restart/open-folder), git-update (safe-dirty-path classification).
- Backend unit tests: asset-pattern matcher + arg flattening (12 passing).
- **Verify:** ✅ installed Windows AVX2 build `master-709-92a3b73`, captured `sd-cli -h` / `--version` (commit 92a3b73).
- **Resolved §16 #3:** upstream ships **no** SHA256 → verification conditionally skipped with a stderr warning (no sumfile, no per-asset `.sha256`, GitHub `assets[]` carries none).
- **Notable:** `save_config`/`BackendServices` type contract fixed (param widened to `Mapping[str, Any]`); `tunnel_service.stop_remote_tunnel` added as a Phase 1 no-op so lifecycle is Phase-5-safe; `.gitkeep` preserved across install/cleanup.

### Phase 2 — Generate (txt2img) ✅

- `definitions.js` v1 (img_gen flags), `categories.js`, `options.js`, `helpers.js`, `flag-core.js`, `config-flags-ui.js`.
- `generate_service.py`: run `sd-cli`, stream output, parse steps, preview polling, collect output, sidecars.
- `generate.py` route + `generate-ui.js` + `gallery-rendering.js`: prompt UI, generate, live preview, gallery, history.
- `/api/models` (type-filtered, size+mtime), `/api/images`, `/api/image/<name>`, thumbnail.
- Backend unit tests + frontend Playwright smoke (Generate→poll→preview→gallery→history + Generate↔Configure sync).
- **Verify:** ✅ generated "a lovely cat" with SD1.5 Q4_0 GGUF via the backend pipeline; preview `preview_mtime` ticked each step (1→3→4→6), result image served via `/api/image/<name>`, and `output/.gallery/*.json` sidecar written.
- **Notable:** flags audited against the installed `sd-cli -h` (commit 92a3b73) — flash attention is `--fa` (not `--flash-attn`), no `--ngl`/`--n-gpu-layers` (uses `--offload-to-cpu`/`--backend`/`--max-vram`), no `--format` (extension-based), metadata opt-out is `--disable-image-metadata`. sd-cli reports per-step progress ONLY via the preview callback writing `--preview-path` (its CLI `step_callback` discards the step number to stdout — confirmed in upstream `main.cpp`); the backend polls preview mtime as the primary signal and parses the carriage-return sampling bar (`N/M - X.XXs/it`) as a secondary signal. Thumbnails are served full-size and scaled client-side (PLAN §16.1 option (b); Pillow intentionally not a dependency).

### Phase 3 — img2img + model bundles + HF downloader ✅

- img2img controls (init-image, strength, mask, control-image), `upscale`/`convert`/`metadata` modes.
- `model-bundles.js` driving file-picker visibility (SDXL, SD3, FLUX, Qwen, Z-Image…).
- `hf_download.py` multi-format + multi-file; `hf-download-ui.js`.
- **Verify:** download a FLUX gguf bundle from HF and generate with it.

### Phase 4 — Configure parity + Presets

- Expand `definitions.js` to the full `sd-cli` flag set (verify against `-h` / `common.cpp`).
- `presets.py` + `presets.js` (CRUD, import/export, grouped by model type), custom launch args.

### Phase 5 — Server mode + API + tunnel

- `SD_SERVER_FLAGS`, `server_mode.py`, `server-ui.js`, `api-tab.js`, `remote-tunnel-ui.js`.

### Phase 6 — Expansion

- Video mode (`vid_gen`), LoRA/ControlNet/PhotoMaker/PuLID panels, advanced backend tuning (`--backend`/`--params-backend`/`--max-vram`), optional `sd-server` `/metrics` proxy, install-packaged launchers (.bat/.sh/.command), Pinokio launcher companion.

---

## 16. Open decisions / risks

1. **Thumbnail generation.** Pillow is not in `requirements.txt`. Options: (a) add Pillow (clean), (b) browser-side downscaling via canvas, (c) serve full images and let CSS scale. **Recommend (b)** to keep deps minimal; revisit if large batches are slow.
2. **Progress-line format.** Must be confirmed against a real `sd-cli` run (the regex in §10 is provisional). Low risk — isolated to `generate.py`.
3. **Asset SHA256 source.** Confirm each release ships a single sha256sums file vs. per-asset `.sha256`. (The listing shows a 16th asset — to verify during Phase 1.)
4. **One vs. two process slots.** Decide whether the one-shot generator and the persistent sd-server share a lock or are independent. **Recommend independent** (two locks in `ServerState`) so Generate works while a server runs.
5. **macOS x64 / Win arm64.** Upstream ships no asset for these today — backend specs should simply offer nothing (graceful "no backend available" message), as LLama-GUI does for unsupported combos.
6. **Naming.** "Stable-D GUI" is provisional; easy to rename later (no architecture impact).

---

## 17. Testing strategy (mirrors LLama-GUI)

- **Frontend syntax:** `node --check ui/js/<file>.js` on every touched file.
- **Frontend unit (Node):** launch-args parser, custom-args parser, flag-def validation, gallery-rendering, model-bundle field-mapping.
- **Frontend smoke (Playwright):** serve `ui/` as web root, stub backend APIs, verify: Generate → Configure sync, command preview, preview polling updates `<img>`, history restore, preset save/load.
- **Backend unit (unittest):** asset-suffix matching, arg flattening, progress-line parsing, HF repo-id/filename validation, gallery sidecar read/write.
- **Manual:** install on Win/Linux/macOS, run each `sd-cli` mode end-to-end, run `sd-server` + tunnel.

> When running local browser smoke checks, serve `ui/` as the web root (root-relative `/js/...` assets require it), exactly like LLama-GUI.
