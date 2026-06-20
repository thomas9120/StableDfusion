# Stable-D GUI — Phased TODO

Mirrors the roadmap in `../PLAN.md` §15. Check items off as they land.

## Phase 0 — Scaffold ✅

- [x] Directory structure
- [x] Bootable `server.py` + `backend/app.py` (serves UI, `/api/status`)
- [x] Generic core: `config`, `context`, `state`, `http`, `routing`
- [x] Stubbed routes (501 TODOs) + service stubs
- [x] Frontend shell: 5-tab `index.html` + JS module namespaces
- [x] `PLAN.md`, `AGENTS.md`, `README.md`, `requirements.txt`, `package.json`

## Phase 1 — Install + backend core ✅

- [x] `sdcpp_manager`: release fetch + glob-pattern asset match + download + extract
- [x] `install` route + `manager.js`: backend select, install/update/repair/remove
- [x] `/api/select-file` (tkinter/osascript), lifecycle (shutdown/restart/open-folder), git-update
- [x] `process_manager`: launch/stream/stop + shared-lib env builder (core plumbing for Phase 2/5)
- [x] Release SHA256 source confirmed: **upstream ships none** → verification skipped with a stderr warning (resolves PLAN.md §16 #3)
- [x] Backend unit tests: asset-pattern matcher (incl. macOS version-wildcard + avx/avx2/avx512 disambiguation) + arg flattening
- [x] Verify: installed a Windows AVX2 release, captured `sd-cli -h` (commit 92a3b73)

**Notes**

- Asset matching is glob-based (`fnmatch`), not tag-derived — macOS variant uses `*-bin-Darwin-macOS-*-arm64.zip` to survive build-OS version bumps.
- `save_config`/`BackendServices` type contract fixed: param widened to `Mapping[str, Any]`.
- `tunnel_service.stop_remote_tunnel` added as a Phase 1 no-op so lifecycle can call it unconditionally (real cloudflared logic is Phase 5).
- Removed `tests/backend/__init__.py` — it made pytest import tests as a `backend` package, colliding with the app's `backend/`.

## Phase 2 — Generate (txt2img)

- [ ] `definitions.js` v1 (img_gen flags), `categories`, `options`, `helpers`, `flag-core`, `config-flags-ui`
- [ ] `generate_service`: run sd-cli, stream, parse step progress, preview polling, collect output, sidecars
- [ ] `generate` route + `generate-ui.js` + `gallery-rendering.js`: prompt UI, generate, live preview, gallery, history
- [ ] `/api/models`, `/api/images`, `/api/image/<name>`, thumbnails
- [ ] Confirm sd-cli step-line format for the progress regex
- [ ] Verify: generate a cat with SD1.5, watch preview tick, see result in gallery

## Phase 3 — img2img + bundles + HF downloader

- [ ] img2img controls (init-image, strength, mask, control-image); upscale/convert/metadata modes
- [ ] `model-bundles.js` driving file-picker visibility
- [ ] `hf_download_service` multi-format/multi-file + `hf-download-ui.js`
- [ ] Verify: download a FLUX gguf bundle from HF and generate with it

## Phase 4 — Configure parity + Presets

- [ ] Expand `definitions.js` to full sd-cli flag set (verify vs `-h` / `common.cpp`)
- [ ] `presets` route + `presets.js` (CRUD, import/export, grouped by model type)
- [ ] Custom launch args parser + command preview

## Phase 5 — Server mode + API + tunnel

- [ ] `SD_SERVER_FLAGS`, `server_mode` route, `server-ui.js`, `api-tab.js`, `remote-tunnel-ui.js`
- [ ] Verify: run sd-server + Cloudflare tunnel, hit `/sdapi/v1/txt2image`

## Phase 6 — Expansion

- [ ] Video mode (`vid_gen`), LoRA/ControlNet/PhotoMaker/PuLID panels
- [ ] Advanced backend tuning (`--backend`/`--params-backend`/`--max-vram`)
- [ ] Optional `sd-server` `/metrics` proxy
- [ ] Packaged launchers (.bat/.sh/.command), Pinokio companion
