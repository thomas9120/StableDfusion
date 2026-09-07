# StableDfusion

A desktop-friendly web GUI for [`leejet/stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp),
modeled on the architecture of its sibling project **LLama-GUI**. No frameworks, no
bundler — just a Python stdlib HTTP server and vanilla JS.

Video generation is still a work in progress, so you may encounter some errors.

Looking for which diffusion model, VAE, and text-encoder files to download? See
[Model weights](#model-weights).

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
                     ├─ /api/*  → backend/routes/*.py (38 endpoints)
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
| `SD_GUI_HOST` | `127.0.0.1` | Bind host. `0.0.0.0` / LAN IP requires `SD_GUI_ALLOWED_HOSTS` (Host allow-list) + `SD_GUI_TOKEN` (or explicit `SD_GUI_ALLOW_INSECURE=1`) |
| `SD_GUI_PORT` | `5250` | GUI port (distinct from LLama-GUI's 5240) |
| `SD_GUI_ALLOWED_HOSTS` | — | Comma-separated extra allowed hosts (LAN IPs / hostnames), admitted as `http://<host>:<port>` origins. **Required** for LAN/`0.0.0.0` access — requests with other `Host` headers get 403 |
| `SD_GUI_TOKEN` | — | Optional shared secret (max 4096 chars, truncated with a stderr warning). When set, mutating `/api/*` and all `/v1` `/sdapi` `/sdcpp` proxy requests require `Authorization: Bearer <token>` or `X-SD-GUI-Token: <token>` |
| `SD_GUI_ALLOW_INSECURE` | off | Set to `1`/`true`/`yes` to allow non-loopback bind **without** a token (explicit opt-in; not recommended) |
| `SD_GUI_PROXY_TIMEOUT` | `1800` | Timeout (seconds) per proxied `/v1` / `/sdapi` / `/sdcpp` request to sd-server |

**Security notes**

- Default bind is loopback only — no token required for local desktop use.
- Binding to `0.0.0.0` / a LAN IP without `SD_GUI_TOKEN` is refused at boot unless `SD_GUI_ALLOW_INSECURE=1`.
- Cloudflare tunnel URLs are public. Prefer keeping sd-server on `127.0.0.1` and using the GUI proxy; set `SD_GUI_TOKEN` if the GUI itself is reachable beyond loopback.
- When a token is configured, the UI sends it if present in `localStorage` / `sessionStorage` key `SD_GUI_TOKEN` (e.g. `localStorage.setItem("SD_GUI_TOKEN", "…")` in the browser console).

Runtime layout (auto-created on boot): `models/`, `output/` (+ `.preview/`, `.gallery/`),
`presets/`, `sdcpp/installs/<tag>/<backend>/bin/` (active runtime),
`sdcpp/bin/` (legacy fallback), `tools/cloudflared/`.

## Project layout

```
server.py            # entrypoint → backend.app.main()
backend/             # app, config, routing, state, http, routes/, services/
ui/                  # index.html + partials/ (tabs), js/ (flags, generate, …), css/
docs/                # directory.md (full reference), cli_flags_report.txt
install.sh / start.sh   (and -windows.bat variants)
```

For the complete as-built reference, see [`docs/directory.md`](docs/directory.md).

## Model weights

Each model needs up to three files: a **diffusion model**, a **VAE**, and a **text
encoder**. Diffusion models and text encoders are **GGUF**; the VAE is **safetensors**.
Files download via the **HF Download** tab (or manually into `models/{diffusion,vae,
text-encoders}/`), where they're auto-routed by purpose.

Links are verified against the official `leejet/stable-diffusion.cpp` model docs.

| Model | Diffusion (GGUF) | VAE (safetensors) | Text encoder (GGUF) |
|---|---|---|---|
| **Z-Image Turbo** | [leejet/Z-Image-Turbo-GGUF](https://huggingface.co/leejet/Z-Image-Turbo-GGUF) | `ae.safetensors` — [black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell) | Qwen3-4B-Instruct-**2507** — [unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) |
| **Z-Image Base** | [unsloth/Z-Image-GGUF](https://huggingface.co/unsloth/Z-Image-GGUF) | `ae.safetensors` — [black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell) | Qwen3-4B-Instruct-**2507** — [unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) |
| **Qwen Image Edit** | [QuantStack/Qwen-Image-Edit-GGUF](https://huggingface.co/QuantStack/Qwen-Image-Edit-GGUF) | `qwen_image_vae.safetensors` — [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/tree/main/split_files/vae) | Qwen2.5-VL-7B-Instruct — [mradermacher/Qwen2.5-VL-7B-Instruct-GGUF](https://huggingface.co/mradermacher/Qwen2.5-VL-7B-Instruct-GGUF) |
| **FLUX.2 Klein 4B** | [leejet/FLUX.2-klein-4B-GGUF](https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF) | `flux2_ae.safetensors` — [black-forest-labs/FLUX.2-dev](https://huggingface.co/black-forest-labs/FLUX.2-dev) | Qwen3-4B — [unsloth/Qwen3-4B-GGUF](https://huggingface.co/unsloth/Qwen3-4B-GGUF) |
| **FLUX.2 Klein 9B** | [leejet/FLUX.2-klein-9B-GGUF](https://huggingface.co/leejet/FLUX.2-klein-9B-GGUF) | `flux2_ae.safetensors` — [black-forest-labs/FLUX.2-dev](https://huggingface.co/black-forest-labs/FLUX.2-dev) | Qwen3-8B — [unsloth/Qwen3-8B-GGUF](https://huggingface.co/unsloth/Qwen3-8B-GGUF) |

### Variants & notes

- **Qwen Image Edit variants** — three diffusion checkpoints exist, all sharing the
  same VAE and text encoder above:
  - 2509: [QuantStack/Qwen-Image-Edit-2509-GGUF](https://huggingface.co/QuantStack/Qwen-Image-Edit-2509-GGUF) — also wants the Qwen2.5-VL mmproj file (`Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf`, same mradermacher repo) as `--llm-vision`.
  - 2511: [unsloth/Qwen-Image-Edit-2511-GGUF](https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF) — requires `--model-args qwen_image_zero_cond_t=true` (the `qwen_image_edit` bundle sets this by default).
- **FLUX.2 Klein "base" variants** — each Klein model has a non-distilled **base**
  sibling (cfg 4.0, ~20 steps instead of cfg 1.0, 4 steps), same VAE and text
  encoder: [FLUX.2-klein-base-4B-GGUF](https://huggingface.co/leejet/FLUX.2-klein-base-4B-GGUF),
  [FLUX.2-klein-base-9B-GGUF](https://huggingface.co/leejet/FLUX.2-klein-base-9B-GGUF).
  An alternative lighter VAE is [black-forest-labs/FLUX.2-small-decoder](https://huggingface.co/black-forest-labs/FLUX.2-small-decoder)
  (`full_encoder_small_decoder.safetensors`).
- **Don't mix the Qwen3-4B encoders** — Z-Image uses `Qwen3-4B-Instruct-2507`,
  while FLUX.2 Klein 4B uses the original `Qwen3-4B`. They are not interchangeable.
- **Don't mix the FLUX VAEs** — Z-Image uses FLUX.1's `ae.safetensors`; FLUX.2 Klein
  uses FLUX.2's `flux2_ae.safetensors`.

## License

MIT.
