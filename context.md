# Code Context — Stable-D GUI

## TL;DR

**Stable-D GUI** is a desktop-friendly web GUI for
[`leejet/stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp),
architecturally mirroring its sibling **LLama-GUI** (Python stdlib `http.server`
backend + vanilla JS frontend, no framework, no bundler). Its signature feature
is a **Generate gallery** workflow that spawns `sd-cli` **one-shot per image**
(prompt → live preview → result → history), plus a separate persistent
**Server & API** tab that runs `sd-server`. All 5 phases of `PLAN.md` are
implemented (Install, Generate+gallery, img2img/bundles/HF, Configure+Presets,
Server+API+tunnel).

## Files Retrieved

1. `PLAN.md` (whole) — the authoritative design (architecture, directory map,
   tabs, module reference, the Generate flow, install, server mode, open
   decisions). Read this first.
2. `AGENTS.md` (whole) — agent workflow rules, the SD-specific gotchas, the
   UI-state-sync rule, frontend/backend pitfalls, naming conventions.
3. `README.md` (whole) — quick start, env vars, layout, diff vs LLama-GUI.
4. `server.py` (1–11) — thin entrypoint delegating to `backend.app.main`.
5. `backend/app.py` (whole) — HTTP handler, CORS, route registry (`API_ROUTER`),
   `configure_services()`, `Handler` class, `main()` that boots
   `ThreadingHTTPServer` on `127.0.0.1:5250`.
6. `backend/config.py` (whole) — paths (`SDCPP_DIR`, `MODELS_DIR`, `OUTPUT_DIR`,
   `OUTPUT_PREVIEW_DIR`, `OUTPUT_GALLERY_DIR`, `PRESETS_DIR`), ports
   (`GUI_PORT=5250`, `SD_SERVER_PORT=1234`), env parsing, GitHub API URL.
7. `backend/context.py` (whole) — `AppContext`, `AppPaths`, `ServerConfig`,
   `BackendServices` dataclasses; `DEFAULT_CONTEXT` singleton imported by `app.py`.
8. `backend/state.py` (whole) — `ServerState` (process slot + generation +
   sd_server + model_download + tunnel + install + preset locks), `AtomicDict`.
9. `backend/routes/generate.py` (whole) — the 4 Generate endpoints.
10. `backend/services/generate_service.py` (whole) — **the core signature feature**.
    `_prepare` → `build_argv` → `_run_job` worker thread → progress parsing →
    sidecar writing → results collection.
11. `backend/services/process_manager.py` (whole) — subprocess launch/stream/stop
    shared by Generate and sd-server; `_build_process_env` prepends `sdcpp/bin`
    to PATH/LD_LIBRARY_PATH/DYLD_LIBRARY_PATH.
12. `backend/services/sdcpp_manager.py` (1–80) — release fetch with 60s cache,
    `build_backend_specs()` returns per-platform `{variant → {label,
    asset_pattern, companion?}}`. Asset matching is **pattern-based** (glob),
    not tag-derived.
13. `backend/services/server_mode_service.py` (1–80) — persistent sd-server
    lifecycle + curated flag allowlists (`CURATED_SERVER_VALUE_FLAGS`,
    `CURATED_SERVER_BOOL_FLAGS`); also serves the `/sdcpp/v1`, `/v1`,
    `/sdapi/v1` reverse proxy (`proxy()`).
14. `backend/routes/status.py` (whole) — `GET /api/status` payload shape
    (installed, executables, missing_runtime_files, available_backends, …).
15. `backend/routes/models.py` (whole) — `GET /api/models?type=<purpose>` lists
    model files filtered by purpose-specific extensions; iterates
    `roots_for_listing()` (component subfolders + legacy root).
16. `ui/index.html` (whole) — sidebar + 6 section panels (Install, Generate,
    Configure, Server & API, HF Download, Presets) + confirm modal + the strict
    ordered `<script>` load list (18 scripts).
17. `ui/js/flag-core.js` (whole) — `window.SDGui.flagCore`: shared state
    (`mode`, `bundle`, `tool`, `flagValues`), `setFlagValue`/`setMode`/
    `setBundle` setters with `notify()` listener fan-out, `getLaunchArgs()`,
    `tokenizeCustomArgs()`, `requiredInputError()`, `applyBundleDefaults()`.
18. `ui/js/generate-ui.js` (1–320, 700–820, 906–1050) — Generate tab UI:
    `generate()`, `poll()` (400 ms interval), `cancel()`, `updateModeSections()`,
    bundle-driven picker rendering, history (localStorage).
19. `ui/js/flags/model-bundles.js` (1–80) — `MODEL_TYPE_BUNDLES` array
    (sd1, sdxl, sd3, flux1, flux2, qwen_image, …) each declaring `fields` and
    `defaults` (incl. mode switch for wan → `vid_gen`).
20. `ui/js/flags/definitions.js` (1–60) — `SD_CLI_FLAGS` + `SD_SERVER_FLAGS`;
    audited against `sd-cli -h` (commit `92a3b73`).
21. `ui/js/app.js` (1–100) — `panelLifecycle` (per-section start/stop hooks),
    `switchSection()`, sidebar nav init, `refreshStatusBadge()`.
22. `docs/directory.md` (whole) — as-built status companion to PLAN.md.

## Key Code

### Entry → Router

`server.py` → `backend.app.main()` boots `ThreadingHTTPServer` and serves
`ui/` + `/api/*`. `API_ROUTER` (a `Router()` fluent chain in `app.py`,
`backend/routing.py`) registers all routes by exact or prefix match.

```python
# backend/app.py — the Generate + Server-related routes
.add("POST", "/api/generate", generate_routes.generate)
.add("GET",  "/api/generate/status", generate_routes.get_status)
.add("GET",  "/api/generate/preview", generate_routes.get_preview)
.add("POST", "/api/generate/cancel", generate_routes.cancel)
.add("POST", "/api/sd-server/start", server_mode_routes.start)
.add("POST", "/api/sd-server/stop",  server_mode_routes.stop)
.add("GET",  "/api/sd-server/status", server_mode_routes.get_status)
```

`/v1/*`, `/sdcpp/v1/*`, `/sdapi/v1/*` (matched by `is_v1_proxy_path`) are
reverse-proxied to the running `sd-server` via `Handler.proxy_to_sd_server`
→ `server_mode_service.proxy()`. CORS-safe-origin check is enforced on every
`/api/*` and proxy request.

### Shared State (`backend/state.py`)

`ServerState` dataclass holds every stateful slot, each with its own
`threading.Lock` (independent so a running `sd-server` does **not** block
Generate, per PLAN §16 #4):

```python
process / process_lock         # shared raw subprocess slot (sd-cli/sd-server)
generation / generation_lock   # AtomicDict for one-shot generate
sd_server / sd_server_lock     # AtomicDict for persistent sd-server
sd_server_process              # separate Popen instance
model_download / model_download_lock   # HF multi-file bundles
remote_tunnel / remote_tunnel_lock     # Cloudflare tunnel
install_lock                            # release install
preset_lock                             # preset JSON CRUD
```

`AtomicDict.update(**kw) → snapshot` is the standard mutate-and-return pattern;
routes call `service.status(ctx)` which just returns a snapshot.

### The Generate flow (the signature feature)

**Frontend** (`ui/js/generate-ui.js:952`):

```js
async function generate() {
  var result = window.SDGui.flagCore.getLaunchArgs();   // {args, error, warnings}
  // LoRA <lora:name:weight> tag is injected into --prompt here
  var body = {
    mode:   window.SDGui.flagCore.getMode(),            // img_gen|vid_gen|upscale|convert|metadata
    bundle: window.SDGui.flagCore.getBundle(),
    args:   result.args,                                 // list of [flag, value?] pairs
    seed:   vals.seed, total_steps: vals.steps,
    preview_method: vals.preview, preview_interval: vals.preview_interval,
    params: vals,                                        // full snapshot for sidecar
  };
  await window.SDGui.fetchJson("/api/generate", { method:"POST", body: JSON.stringify(body) });
  startPolling();                                        // setInterval(poll, 400)
}
async function poll() {                                   // generate-ui.js:906
  var snap = await window.SDGui.fetchJson("/api/generate/status");
  updateProgress(snap);
  if (snap.state === "running") {
    if (snap.preview_mtime !== lastPreviewMtime) { lastPreviewMtime = snap.preview_mtime;
      refreshPreview(snap.preview_mtime); /* cache-bust <img> */ }
    return;
  }
  stopPolling(); setGenerating(false);
  if (snap.state === "done")     renderResult(snap);
  else if (snap.state === "error")   renderResultError(snap);
}
```

**Backend** (`backend/services/generate_service.py`):

1. `run(ctx, request)` → `_prepare()` validates mode, args, seed, total_steps;
   computes `output_path = output/<UTC ts>_<seed>.<ext>` and
   `preview_path = output/.preview/<base>.png`.
2. `build_argv()` strips backend-owned flags (`-M`, `-o`, `--preview-path`)
   from the structured pair form, flattens via
   `process_manager.flatten_launch_args`, validates tokens (no control chars,
   ≤4096 chars), then prepends `["-M", mode, ...cleaned, "-o", out,
   "--preview-path", preview, "--preview", method]`.
3. `_run_job()` runs in a daemon thread under `generation_lock`:
   - `process_manager.launch_process(ctx, "sd-cli", argv)` → one process at a
     time. Background threads stream stdout/stderr into
     `state.output_buffer` / `state.stderr_buffer` (capped at
     `PROCESS_OUTPUT_LIMIT=5000` lines).
   - Worker polls `proc.poll()` every 0.25 s. Primary progress signal =
     **preview file mtime change** (sd-cli only reports steps via the
     `--preview-path` callback, not stdout). Secondary signal =
     `parse_step_progress()` regex over the stdout tail
     (`(\d+)\s*/\s*(\d+)\s*-\s*[\d.]+\s*s/it` sampling bar, fallback
     `step N/M`).
   - On cancel: `state.generation_cancel.set()` → `stop_process()`.
   - On non-zero exit → `state="error"` with stdout/stderr tail.
   - On success: `_collect_results()` globs `<base_name>*`, writes the JSON
     sidecar `output/.gallery/<base>.json` (params, seed, files,
     `created_at`, warnings, `stderr_tail`, `stdout_excerpt` for metadata
     mode), sets `state="done"` with `result_files`.

**Endpoints** (`backend/routes/generate.py`):

| Endpoint | Purpose |
|---|---|
| `POST /api/generate` | start; returns `{job_id, status_url, preview_url}` or `{error}` (400) |
| `GET /api/generate/status` | AtomicDict snapshot: `state, job_id, step, total_steps, percent, preview_mtime, result_files, warnings, stderr_tail, stdout_excerpt` |
| `GET /api/generate/preview` | reads `output/.preview/<job_id>.png` as `image/png` (404 if not yet written) |
| `POST /api/generate/cancel` | sets `generation_cancel` and stops the process |

### Frontend shared state (`window.SDGui.flagCore`)

The UI-state-sync rule: **all** writes route through `setFlagValue(id, value)`,
which calls `notify()` to fan out to every registered listener (Generate tab,
Configure tab, command preview). `getLaunchArgs()` is the single source of
truth for the argv:

```js
// ui/js/flag-core.js
state = { mode:"img_gen", bundle:"sd1", tool:"sd-cli", flagValues: {...defaultsFromFlags()} };
function getLaunchArgs() {
  var args = [];
  (window.SDGui.SD_CLI_FLAGS || []).forEach((f) => {
    if (!modeMatches(f) || f.backendOwned) return;
    var v = state.flagValues[f.id];
    if (f.type === "bool") { if (v === true) args.push([f.flag]); return; }
    if (v === f.default || v === "") return;
    args.push([f.flag, String(v)]);
  });
  tokenizeCustomArgs(state.flagValues.custom_args).forEach(t => args.push([t]));
  var err = requiredInputError(state.flagValues);   // per-mode required input check
  return { args, error: err, warnings };
}
```

`applyBundleDefaults(bundleValue)` overlays a bundle's `defaults` (width,
height, steps, cfg, optionally `mode` for `vid_gen`).

### Model-type bundles (`ui/js/flags/model-bundles.js`)

`MODEL_TYPE_BUNDLES` (sd1, sdxl, sd3, flux1, flux2, qwen_image, wan, z_image,
custom) each declare `fields: [{key, purpose, required}]` driving **which
file pickers render** in the Generate tab, and `defaults` to apply on selection.
`purpose` matches `backend/routes/file_picker.py`'s `PURPOSE_FILTERS`
(`diffusion_model`, `vae`, `clip_l`, `clip_g`, `t5xxl`, `llm`, `lora`, …).

### Install / release mgmt (`backend/services/sdcpp_manager.py`)

`build_backend_specs(platform, arch)` returns e.g. for Win x64:

```python
{ "cpu-avx2":  {"label":"CPU (AVX2) — recommended", "asset_pattern":"*-bin-win-avx2-x64.zip"},
  "cuda12":    {"label":"CUDA 12 (NVIDIA)",          "asset_pattern":"*-bin-win-cuda12-x64.zip",
                "companion":"cudart-sd-bin-win-cu12-x64.zip"},
  "vulkan":    {...}, "rocm-7.1.1": {...}, "rocm-7.13.0": {...}, ... }
```

Install: find asset whose name **glob-matches** the suffix → stream download →
**SHA256 skipped** (upstream ships none, PLAN §16 #3 resolved) → flat zip extract
into `sdcpp/bin/` → write `config.json = {version, backend, tag}`.
`validate_runtime_dependencies()` reports missing shared libs (macOS uses
`otool -L`; on Win/Linux checks that sibling `.dll`/`.so` exist).

### Server mode (`backend/services/server_mode_service.py`)

A curated `SD_SERVER_FLAGS` subset (listener, model bundle paths, core gen
defaults, `--threads`, `--backend`, `--params-backend`, `--max-vram`,
`--diffusion-fa`, `--offload-to-cpu`, `--mmap`) + free-form "extra server args"
textarea. Uses a **separate** `sd_server_process` slot from the one-shot
generator. The `Handler` reverse-proxies `/v1`, `/sdcpp/v1`, `/sdapi/v1` to
`http://127.0.0.1:1234`.

## Architecture

```
Browser  ──HTTP──►  backend/app.py (ThreadingHTTPServer :5250)
                      │
                      ├── static ui/            (SimpleHTTPRequestHandler)
                      ├── API_ROUTER ─────────► routes/*.py  → services/*.py
                      │       (one route module per resource; services use
                      │        `_service` suffix to avoid basename collisions)
                      └── /v1/* proxy ────────► server_mode_service.proxy()
                                                  → running sd-server (:1234)

services/process_manager.py  ─ spawn sdcpp/bin/sd-cli    (one-shot, in state.process)
                             ─ spawn sdcpp/bin/sd-server (persistent, in state.sd_server_process)
                             (PATH/LD/DYLD_LIBRARY_PATH ← sdcpp/bin prepended)

state.ServerState  ─ every slot has its own lock:
                      generation_lock | sd_server_lock | model_download_lock
                      remote_tunnel_lock | install_lock | preset_lock | process_lock
```

**Tabs** (6 in `index.html`, `data-section` ids):
`install`, `generate` (default/landing), `configure`, `server`, `hf-download`,
`presets`. Each JS module attaches to `window.SDGui.<module>`. Section switching
runs `panelLifecycle.setActive(section)` which fires per-section `start`/`stop`
hooks so pollers pause off-tab.

**Backend ↔ Frontend contract**:

- Frontend builds argv from `flagCore.getLaunchArgs()` and POSTs it as `args`
  (a `[flag, value?]` pair list). Backend owns `-M`, `-o`, `--preview-path` and
  strips any user-supplied occurrence.
- `params` is a full snapshot of `flagValues` for the sidecar (history restore,
  preset save). It is **not** used to build argv — argv comes only from `args`.
- Live preview = poll `GET /api/generate/status`, on `preview_mtime` change
  refresh `<img src="/api/generate/preview?t=<mtime>">` (cache-bust query).
- History lives in `localStorage["sdgui.generate.history"]` on the client;
  sidecars in `output/.gallery/<base>.json` are the durable on-disk record.

**Naming conventions** (AGENTS.md): service modules sharing a basename with a
route module use `_service` suffix (`generate_service`, `hf_download_service`,
`tunnel_service`, `lifecycle_service`, `file_picker_service`,
`git_update_service`, `server_mode_service`, `model_storage_service`);
`sdcpp_manager` and `process_manager` keep `_manager`.

## Start Here

1. **`PLAN.md`** — full design (the only doc that explains *why*). §5 directory
   map, §6 tabs, §10 the Generate flow, §11 install, §16 open decisions.
2. **`backend/app.py`** (`API_ROUTER` near the bottom) — every endpoint lives
   here; trace any `/api/*` from this table.
3. **`backend/services/generate_service.py`** — the signature feature in one
   file. Read `_prepare` → `build_argv` → `_run_job` end-to-end.
4. **`ui/js/flag-core.js`** — the frontend state contract every tab depends on
   (`getLaunchArgs()` is the agreed argv shape).
5. **`ui/index.html`** — DOM ids every JS module references; the `<script>`
   load order at the bottom is **load-bearing** (PLAN §8).

## Verify After Every Change (AGENTS.md)

- `node --check ui/js/<file>.js` for every touched JS file.
- `ruff check . && ruff format .` for Python.
- `python server.py` then `curl http://127.0.0.1:5250/api/status`.
- Serve `ui/` as web root for browser smoke (root-relative `/js/...` requires it).
- Tests: `tests/backend/test_*.py` (unittest) and
  `tests/frontend/{js_syntax_check,flag_sync_smoke}.cjs` (Node + Playwright).

## Constraints, Risks, Open Questions

- **Backend-owned flags**: never let the frontend set `-M`, `-o`,
  `--preview-path`. `build_argv` strips them defensively; respect this.
- **Progress signal is fragile**: sd-cli reports steps ONLY via the
  `--preview-path` callback (its `step_callback` discards the step number to
  stdout — verified in upstream `examples/cli/main.cpp`). mtime polling is the
  primary signal; the `\d+/\d+ - X.XXs/it` regex is secondary.
- **No Pillow**: thumbnails served full-size and scaled client-side (PLAN §16 #1
  → option (b)). `/api/image/<name>/thumbnail` is the same bytes as the image.
- **No SHA256 verification** of releases (upstream ships none; PLAN §16 #3
  resolved as conditional skip).
- **Multi-file model requirement**: `requiredInputError()` and the Z-Image
  `--llm`-≠-`--diffusion-model` guard in `flag-core.js` are the only client-side
  guards; the backend re-checks model presence in `_prepare`.
- **Z-Image-Turbo footgun**: `--llm` must be a separate Qwen3-4B GGUF, not the
  diffusion model file — enforced both client-side (warning + error) and via
  the sidecar.
- **Unsupported platforms**: macOS x64 / Win arm64 have no upstream assets;
  `build_backend_specs` returns `{}` → "no backend available" message.
- **Service module naming footgun**: a route must not share a basename with its
  imported service (the `_service` suffix exists to dodge this).
- **Phase 6 deferred**: video (`vid_gen`) UI exists but the full video preview
  story, LoRA/ControlNet panels, `/metrics` proxy, and packaged launchers are
  not yet built (PLAN §15).
- **`APP_REPO_URL`** in `config.py` still has a `TODO: set real repo` for the
  git auto-updater.
