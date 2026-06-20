# StableDfusion

A desktop-friendly web GUI for [`leejet/stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp),
modeled on the architecture of **LLama-GUI** (its sibling project for `llama.cpp`).



## What it is

A two-mode launcher for stable-diffusion.cpp:

- **Generate** (primary): a gallery workflow that runs `sd-cli` one-shot per
  image — prompt → live preview → result thumbnail → history. Supports txt2img,
  img2img, upscale, convert, metadata, and video modes.
- **Server & API**: launch `sd-server` persistently and hit its
  OpenAI/SDAPI-compatible endpoints (+ optional Cloudflare tunnel).

## Quick start



Then use the **Install** tab to download a `stable-diffusion.cpp` release and
pick a backend (CUDA 12 / Vulkan / ROCm / CPU-AVX2 / Metal …).

## Layout



## Configuration

| Env | Default | Purpose |
|---|---|---|
| `SD_GUI_HOST` | `127.0.0.1` | GUI bind host (`0.0.0.0` for LAN) |
| `SD_GUI_PORT` | `5250` | GUI port (distinct from LLama-GUI's 5240) |
| `SD_GUI_ALLOWED_HOSTS` | — | Comma-separated extra allowed origins |
