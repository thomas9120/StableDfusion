# Stable-D GUI

A desktop-friendly web GUI for [`leejet/stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp),
modeled on the architecture of **LLama-GUI** (its sibling project for `llama.cpp`).

> **Status: scaffold (Phase 0).** The project structure, bootable backend, and
> UI shell are in place. Feature implementation follows the phased roadmap in
> [`PLAN.md`](./PLAN.md).

## What it is

A two-mode launcher for stable-diffusion.cpp:

- **Generate** (primary): a gallery workflow that runs `sd-cli` one-shot per
  image — prompt → live preview → result thumbnail → history. Supports txt2img,
  img2img, upscale, convert, metadata, and video modes.
- **Server & API**: launch `sd-server` persistently and hit its
  OpenAI/SDAPI-compatible endpoints (+ optional Cloudflare tunnel).

## Quick start

```bash
pip install -r requirements.txt
python server.py
# open http://127.0.0.1:5250
```

Then use the **Install** tab to download a `stable-diffusion.cpp` release and
pick a backend (CUDA 12 / Vulkan / ROCm / CPU-AVX2 / Metal …).

## Layout

See [`PLAN.md`](./PLAN.md) for the full architecture, directory map, tab-by-tab
design, and phased roadmap. Agent workflow rules are in
[`AGENTS.md`](./AGENTS.md).

| Path | Role |
|---|---|
| `server.py` | Entrypoint → `backend.app` |
| `backend/` | HTTP server, routes, services, state (Python stdlib) |
| `ui/` | Static frontend (vanilla HTML/CSS/JS, no bundler) |
| `sdcpp/bin/` | Downloaded `sd-cli` / `sd-server` binaries |
| `models/` | User model component folders (`diffusion/`, `vae/`, `text-encoders/`, `loras/`) |
| `output/` | Generated images + gallery sidecars |

## Differences from LLama-GUI

- **No chat / benchmarking / web search** (not applicable to image generation).
- `sd-cli` is **one-shot** (run per image), unlike `llama-server` (persistent) —
  the GUI's signature feature is the in-app **Generate gallery**.
- SD models are **multi-file** (diffusion-model + VAE + CLIP/T5/LLM), so the
  Generate tab is driven by **model-type bundles** and organized component
  folders instead of one flat model directory.
- Releases are continuous builds (`master-<n>-<commit>`); assets are matched by
  **suffix pattern** rather than constructed from the tag.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `SD_GUI_HOST` | `127.0.0.1` | GUI bind host (`0.0.0.0` for LAN) |
| `SD_GUI_PORT` | `5250` | GUI port (distinct from LLama-GUI's 5240) |
| `SD_GUI_ALLOWED_HOSTS` | — | Comma-separated extra allowed origins |
