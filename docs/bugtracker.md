# StableDfusion — Bug Tracker

Findings from the full code review (backend services, routes, frontend).
Severity: Critical / High / Medium / Low. Status tracked per item.

Linters pass clean (`ruff check .`, `node --check` on all `ui/**/*.js`); the
issues below are logic / concurrency / security / state-sync bugs.

Legend: `[ ]` open · `[~]` in progress · `[x]` fixed

---

## Critical

### C1 — `is_safe_request_origin` compares bare hostname to full-origin strings → all non-loopback API/proxy requests 403
- **File:** `backend/http.py:48-49`
- **Category:** Auth/origin (logic bug)
- **Desc:** `host = parsed.hostname` (e.g. `abc.trycloudflare.com`) is tested via
  `host.lower() in allowed_origins`, but `get_allowed_request_origins` fills that
  set with full origins like `http://127.0.0.1:5250`. A bare hostname is never in
  that set, so the branch is always False for non-loopback. Only `_loopback_host`
  passes.
- **Impact:** Cloudflare tunnel + all LAN/remote access to `/api/*` and `/v1/*`
  are completely non-functional (every request 403s).
- **Status:** `[x]`

---

## High

### H1 — `get_allowed_request_origins` always passes `None` for the tunnel URL
- **File:** `backend/app.py:190-197`
- **Category:** Auth/origin
- **Desc:** `Handler.get_allowed_request_origins` hardcodes `None` for the
  tunnel URL instead of reading `ctx.state.remote_tunnel.snapshot().get("url")`.
- **Impact:** Even with C1 fixed, the tunnel origin is never registered as
  allowed; tunnel API access 403s at a second independent point.
- **Status:** `[x]`

### H2 — `_extract_zip_flat` discards Unix permission bits → binaries not executable on Linux/macOS
- **File:** `backend/services/sdcpp_manager.py:469-478`
- **Category:** Cross-platform
- **Desc:** Files written with `open(out_path, "wb")` (mode 0644); the stored
  `info.external_attr` mode is never applied. `validate_runtime_dependencies`
  only checks `exists()` on non-darwin, so the failure surfaces only at launch
  as `PermissionError`.
- **Impact:** Runtime unusable on Linux/macOS.
- **Status:** `[x]`

### H3 — `install_release` deletes existing runtime before extraction → failed repair/reinstall bricks install
- **File:** `backend/services/sdcpp_manager.py:652-660`
- **Category:** Resource/logic (data loss on partial failure)
- **Desc:** `shutil.rmtree(target_bin)` runs before `extract_archive_flat`;
  `_upsert_runtime` runs only after. If extraction raises, the previously-working
  runtime is already gone.
- **Impact:** Silent data loss with no recovery on repair/same-tag reinstall.
- **Status:** `[x]`

### H4 — `restart_gui_server` shuts down unconditionally, then may fail to spawn replacement
- **File:** `backend/services/lifecycle_service.py:88-121`
- **Category:** Logic/resource
- **Desc:** The shutdown thread starts immediately; if `Popen` raises in
  `_restart`, the `except` returns before `os._exit(0)` while the server is
  already being stopped.
- **Impact:** Failed restart leaves no backend.
- **Status:** `[x]`

### H5 — Unvalidated `tag` interpolated into GitHub API URL
- **File:** `backend/services/sdcpp_manager.py:392-398` (via `install.py:85-105`, `137-159`)
- **Category:** Security (URL injection / unvalidated external input)
- **Desc:** `tag` from the request body is placed raw into
  `f"{ctx.config.github_api}/tags/{tag}"` before any format validation.
- **Impact:** API-path injection against `api.github.com`; untrusted-asset download.
- **Status:** `[x]`

### H6 — `set_active_runtime` / `remove_runtime` / `cleanup_sdcpp` mutate install state with no `install_lock`
- **File:** `backend/routes/install.py:121-134,184-197,200-207`
- **Category:** Concurrency
- **Desc:** These check only `_runtime_process_running`, never `install_in_progress`
  and never acquire `install_lock`. Can race with an in-progress install thread
  (config.json write / rmtree mid-extract).
- **Impact:** Data loss/corruption; violates the stateful-lock rule.
- **Status:** `[x]`

### H7 — `stop_remote_tunnel` reads/writes `remote_tunnel_process` without `remote_tunnel_lock`
- **File:** `backend/services/tunnel_service.py:176-198`
- **Category:** Concurrency
- **Desc:** `start` and `_monitor` take the lock; `stop` does not. Can observe a
  stale `None` or clear a freshly-spawned process handle.
- **Impact:** Orphaned cloudflared subprocess, port leak, inconsistent state.
- **Status:** `[x]`

### H8 — Negative `Content-Length` causes blocking read (thread-exhaustion DoS)
- **File:** `backend/app.py:210-225`
- **Category:** Input validation / DoS
- **Desc:** `int(self.headers.get("Content-Length", 0))` has no lower bound;
  `Content-Length: -1` passes both guards and `self.rfile.read(-1)` blocks until
  EOF on a keep-alive connection.
- **Impact:** Handful of malicious requests starve the thread pool.
- **Status:** `[x]`

### H9 — `restoreFromHistory` clobbers restored prompt via `setMode` ordering
- **File:** `ui/js/generate/history.js:158-167`
- **Category:** State-sync violation
- **Desc:** `setMultipleFlagValues(entry.params)` runs before `setMode(entry.mode)`;
  `setMode` then overwrites the prompt via `restorePromptForMode` and corrupts the
  old mode's saved slot. `applyPreset` does the same ops in the correct order.
- **Impact:** Restoring a cross-mode history entry silently loses the prompt.
- **Status:** `[x]`

### H10 — Configure tab renders `backendOwned` flags as editable, desyncing state
- **File:** `ui/js/config-flags-ui.js:84-85` (+ `ui/js/flags/helpers.js:36-37`, `ui/js/flag-core.js:194`)
- **Category:** State-sync violation
- **Desc:** `getFlagsByCategory` never filters `backendOwned`, so `run_mode`,
  `output`, `preview_path` render as inputs wired to `setFlagValue`. Editing
  `run_mode` sets `flagValues.run_mode` without changing `state.mode`; `getLaunchArgs`
  then silently drops it.
- **Impact:** Edits to backend-owned controls have no effect but desync shared state.
- **Status:** `[x]`

---

## Medium

### M1 — `launch_process` holds `process_lock` across `validate_runtime_dependencies` + `Popen`
- **File:** `backend/services/process_manager.py:94-145`
- **Status:** `[x]`

### M2 — `stop_process` holds `process_lock` across `proc.wait(timeout=5)`
- **File:** `backend/services/process_manager.py:152-172`
- **Status:** `[x]`

### M3 — `server_mode_service.start` holds `sd_server_lock` across validate + Popen
- **File:** `backend/services/server_mode_service.py:218-288`
- **Status:** `[x]`

### M4 — `tunnel_service.start` holds `remote_tunnel_lock` across cloudflared download
- **File:** `backend/services/tunnel_service.py:137-169`
- **Status:** `[x]`

### M5 — `_append_log` read-modify-write race between the two tunnel stream threads
- **File:** `backend/services/tunnel_service.py:90-105`
- **Status:** `[x]`

### M6 — `proxy` connects to raw `0.0.0.0`/`::` listen host instead of normalized `127.0.0.1`
- **File:** `backend/services/server_mode_service.py:346-349`
- **Status:** `[x]`

### M7 — `_tokenize_extra` bypasses the curated-flag allowlist
- **File:** `backend/services/server_mode_service.py:143-152`
- **Status:** `[x]`

### M8 — `validate_hf_filename` regex rejects legitimate HF filenames (spaces, parens, `+`)
- **File:** `backend/services/hf_download_service.py:44`
- **Status:** `[x]`

### M9 — `update_runtime` treats `releases[0]` as "latest" without checking `prerelease`
- **File:** `backend/services/sdcpp_manager.py:688-689`
- **Status:** `[x]`

### M10 — `remove_runtime` rmtree's the shared legacy `sdcpp/bin` when removing an active runtime
- **File:** `backend/services/sdcpp_manager.py:264-272`
- **Status:** `[x]`

### M11 — `find_tool_executable` ignores caller's `ctx`, resolves against global `APP_CONTEXT`
- **File:** `backend/app.py:121-124`
- **Status:** `[x]`

### M12 — `generate_service` pushes raw `stderr_tail`/`stdout_tail`/`error` into client-facing status
- **File:** `backend/services/generate_service.py:477-498,528-529,560-561,566`
- **Status:** `[x]`

### M13 — `update_app_from_git` has no lock around `git pull` + `pip install`
- **File:** `backend/services/git_update_service.py:254-309`
- **Status:** `[x]`

### M14 — `list_models` / `generate` / `file_picker` / `git_update` routes have missing exception handling
- **File:** `backend/routes/models.py:44-79`, `generate.py:14-19`, `file_picker.py`, `git_update.py`
- **Status:** `[x]`

### M15 — `serve_image` reads entire file into memory, no Range support
- **File:** `backend/routes/images.py:65-80`
- **Status:** `[x]`

### M16 — Install thread `finally` has no `except` → stuck "downloading" state on pre-try exceptions
- **File:** `backend/routes/install.py:98-104,146-158,166-172`
- **Status:** `[x]`

### M17 — `run-controller.poll()` has no in-flight guard → overlapping polls double-add history
- **File:** `ui/js/generate/run-controller.js:112-151,160-163`
- **Status:** `[x]`

### M18 — `confirmAction` Enter confirms even when Cancel is focused
- **File:** `ui/js/manager.js:151-159`
- **Status:** `[x]`

### M19 — Configure inputs go stale after history-restore / bundle-switch
- **File:** `ui/js/config-flags-ui.js:193-197`, `ui/js/generate/history.js:158-167`, `ui/js/generate-ui.js:436-451`
- **Status:** `[x]`

### M20 — Configure number inputs persist `NaN` into shared state
- **File:** `ui/js/config-flags-ui.js:58-63`
- **Status:** `[x]`

### M21 — HF download poller never stops on transient errors; not registered with `panelLifecycle`
- **File:** `ui/js/hf-download-ui.js:272-320,354-393`
- **Status:** `[x]`

### M22 — 5s `refreshStatusBadge` does full Install DOM rebuild with no in-flight guard; re-enables runtime buttons mid-repair
- **File:** `ui/js/app.js:229`, `ui/js/manager.js:412-599,1043-1046`
- **Status:** `[x]`

### M23 — Shared `#generate-workbench`: a running job in one mode corrupts other sections' button/result UI
- **File:** `ui/js/generate/run-controller.js:95-101`, `ui/js/generate-ui.js:232-242,354-367`
- **Status:** `[x]`

### M24 — `sendToImg2img` double-prefixes `output/`
- **File:** `ui/js/generate-ui.js:333-335`
- **Status:** `[x]`

### M25 — `convert` required-input check rejects `diffusion_model`-only bundles
- **File:** `ui/js/flag-core.js:157-161`
- **Status:** `[x]`

### M26 — `.webp` always rendered as `<video>`, breaking static webp images
- **File:** `ui/js/gallery-rendering.js:28,35-37`
- **Status:** `[x]`

### M27 — Per-keystroke full `syncFromState` + dimension-button rebuild
- **File:** `ui/js/generate-ui.js:584-588`, `ui/js/generate/dimensions.js:116`
- **Status:** `[x]`

---

## Low

### L1 — `get_releases` / `get_status` use substring matching for query params
- **File:** `backend/routes/install.py:63`, `backend/routes/git_update.py:13`
- **Status:** `[x]`

### L2 — `serve_image` does not URL-decode `name`
- **File:** `backend/routes/images.py:66`
- **Status:** `[x]`

### L3 — `do_POST` parses body before origin check (minor DoS amplification)
- **File:** `backend/app.py:301-308`
- **Status:** `[x]`

### L4 — `_validate_name` misses Windows reserved `COM1-9` / `LPT1-9`
- **File:** `backend/routes/presets.py:40-42`
- **Status:** `[x]`

### L5 — `do_DELETE` silently turns invalid JSON body into `{}` (vs `do_POST` 400)
- **File:** `backend/app.py:322`
- **Status:** `[x]`

### L6 — `dispatch` returns 404 for wrong-method (should be 405)
- **File:** `backend/app.py:228-231`
- **Status:** `[x]`

### L7 — "already running" returns 400 (should be 409) for generate + HF download
- **File:** `backend/routes/generate.py:14-19`, `backend/routes/hf_download.py:38-44`
- **Status:** `[x]`

### L8 — `infer_subdir_for_filename` greedy keyword order misroutes ambiguous filenames
- **File:** `backend/services/model_storage_service.py:102-134`
- **Status:** `[x]`

### L9 — `parse_step_progress` only fires after `\n` (sampling end); live stdout step signal dead
- **File:** `backend/services/generate_service.py:116-132`
- **Status:** `[x]`

### L10 — `stream_output` bare `except Exception: pass`
- **File:** `backend/services/process_manager.py:80-81`
- **Status:** `[x]`

### L11 — `_collect_results` glob `base_name*` can cross-pollute same-second jobs
- **File:** `backend/services/generate_service.py:373`
- **Status:** `[x]`

### L12 — `applyBundleDefaults` changes mode without saving/restoring per-mode prompts
- **File:** `ui/js/flag-core.js:52-62`
- **Status:** `[x]`

### L13 — `getSnapshot` / `getFlagValues` return live `flagValues` reference
- **File:** `ui/js/flag-core.js:38-45,302`
- **Status:** `[x]`

### L14 — `validateFlagDefinitions` defined but never called at startup
- **File:** `ui/js/flag-validation.js:6`
- **Status:** `[x]`

### L15 — Deprecated alias flags (`--tae`, `--qwen2vl`) can be emitted alongside primaries
- **File:** `ui/js/flags/definitions.js:511-550`
- **Status:** `[x]`

### L16 — `<lora:…>` tags baked into PNG metadata via `--prompt`
- **File:** `ui/js/generate/run-controller.js:204-223`
- **Status:** `[x]`

### L17 — HF default-selection regex pre-checks both GGUF and safetensors
- **File:** `ui/js/hf-download-ui.js:176`
- **Status:** `[x]`
