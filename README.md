# StableDfusion

A desktop-friendly web GUI for [`leejet/stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp),
modeled on the architecture of its sibling project **LLama-GUI**. No frameworks, no
bundler — just a Python stdlib HTTP server and vanilla JS.

Video generation is still a work in progress, so you may encounter some errors.

## What it is

A two-mode launcher for stable-diffusion.cpp:

- **Generate** (primary): a gallery workflow that runs `sd-cli` one-shot per image —
  prompt → live step preview → result thumbnail → history. Covers image, video,
  upscale, convert, and metadata modes.
- **Server & API**: launch `sd-server` persistently and hit its
  OpenAI (`/v1`) / SDAPI (`/sdapi`) / sdcpp (`/sdcpp`) endpoints, optionally over a
  Cloudflare tunnel.

Both binaries are downloaded and managed by the **Install** tab — you don't need a
local build of stable-diffusion.cpp.

## Quick start

**Requirements:** Python ≥ 3.11. (Node is optional, only for frontend smoke tests.)

```sh
# 1. Install (creates .venv, pip-installs requirements, optional npm deps)
./install.sh                 # macOS / Linux
install-windows.bat          # Windows

# 2. Launch (opens the browser, runs the server)
./start.sh                   # macOS / Linux
start-windows.bat            # Windows
```

Or run directly:

```sh
python server.py             # → http://127.0.0.1:5250
```

On first launch, open the **Install** tab to download a `stable-diffusion.cpp`
release and pick a backend for your platform (CUDA 12, Vulkan, ROCm, CPU-AVX2,
Metal, …). Then switch to **Generate Image** and start creating.

## Tabs

| Tab | Purpose |
|---|---|
| **Install** | Download / update / remove `sd-cli` + `sd-server` binaries; pick a backend |
| **Generate Image** | txt2img / img2img with live preview, gallery, and history |
| **Generate Video** | Video (`.webm`) generation |
| **Upscale** | Upscale an image with an upscaler model |
| **Convert** | Convert checkpoints to `.gguf` |
| **Configure** | Inspect and tweak every `sd-cli` / `sd-server` flag with a live command preview |
| **Server & API** | Run `sd-server` persistently + endpoint docs for OpenAI/SDAPI/sdcpp |
| **HF Download** | Browse and stream multi-file model bundles from Hugging Face |
| **Presets** | Save / restore / export generation presets |

## Features

- **One-shot generation** with per-step progress parsing and live preview polling
- **Model bundles** drive the file pickers per model type (`sd1`, `sdxl`, `sd3`,
  `flux1/2`, `qwen_image`, `wan`, `ltx`, `z_image`, `custom`) — each applies
  sensible defaults for dimensions, steps, CFG, and required components
- **Hugging Face downloads** auto-routed to `models/{diffusion,vae,text-encoders,loras,upscalers}`
- **Cloudflare tunnel** — one-click public URL, `cloudflared` auto-downloaded
- **Git auto-update** with safe dirty-path detection and `pip install` on pull
- **Open folder** shortcuts to `models/`, `output/`, `presets/`, etc.

## How it works

```
python server.py  →  backend/app.py  (stdlib ThreadingHTTPServer)
                     ├─ serves ui/ as the web root
                     ├─ /api/*  → backend/routes/*.py (33 endpoints)
                     └─ /v1, /sdapi, /sdcpp/*  → proxied to running sd-server (127.0.0.1:1234)
```

- `sd-cli` is invoked **one-shot** per generation (`backend/services/generate_service.py`).
- `sd-server` is a **separate** persistent process with its own lock, so it can run
  alongside an in-progress generation.
- All UI state lives in one shared `window.SDGui.flagCore`; writes go through a single
  `setFlagValue()` setter, so Generate and Configure always stay in sync.
- `ui/js/flags/definitions.js` is the single source of truth for every flag,
  audited against `sd-cli -h`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SD_GUI_HOST` | `127.0.0.1` | Bind host (`0.0.0.0` or `*` for LAN access) |
| `SD_GUI_PORT` | `5250` | GUI port (distinct from LLama-GUI's 5240) |
| `SD_GUI_ALLOWED_HOSTS` | — | Comma-separated extra allowed origins (LAN / tunnel) |

Runtime layout (auto-created on boot): `models/`, `output/` (+ `.preview/`, `.gallery/`),
`presets/`, `sdcpp/bin/`, `tools/cloudflared/`.

## Project layout

```
server.py            # entrypoint → backend.app.main()
backend/             # app, config, routing, state, http, routes/, services/
ui/                  # index.html + partials/ (tabs), js/ (flags, generate, …), css/
docs/                # directory.md (full reference), cli_flags_report.txt
install.sh / start.sh   (and -windows.bat variants)
```

For the complete as-built reference, see [`docs/directory.md`](docs/directory.md).

## License

MIT.
