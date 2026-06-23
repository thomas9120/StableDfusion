# Inpainting Support — Implementation Plan

## Background

stable-diffusion.cpp (`sd-cli`) supports inpainting via these flags:

| Flag | Purpose |
|---|---|
| `--init-img` | Source image (the base to inpaint over) |
| `--mask` | 1-channel grayscale mask: white (255) = keep, black (0) = inpaint |
| `--strength` | Denoising strength (0–1, default 0.75) |
| `--img-cfg-scale` | Image guidance scale for inpaint/edit models |

If no `--mask` is provided, sd-cli auto-generates an all-white mask (entire
image kept), which is equivalent to classic img2img.  The mask dimensions
must match the init image — sd-cli resizes both to the output dimensions.

## Current State in StableDfusion

All the necessary **flags** are already defined in `ui/js/flags/definitions.js`
(`mask`, `init_img`, `strength`, `img_cfg_scale`).  HTML form fields and JS
bindings exist in the generate-image partial and `ui/js/generate-ui.js`.

**What's missing** is a **canvas-based mask drawing tool** — users currently
need to supply a pre-made mask file from an external tool like Photoshop or
GIMP.  The feature described below adds a simple paint editor so users can
draw the mask directly in the GUI.

## Implementation Steps

### Step 1 — Backend route to save mask PNG

**New file:** `backend/routes/inpaint_tool.py`

`POST /api/inpaint/save-mask` receives `{ "data_url": "data:image/png;base64,..." }`,
decodes it, writes to `output/.inpaint/mask-{timestamp}.png`, and returns
`{ "path": "output/.inpaint/mask-....png" }`.

Uses only Python stdlib (`base64`, `re`, `Path`).  Validate the data URL
prefix with a strict regex; reject anything that isn't a valid base64 PNG.

Wire into `API_ROUTER` in `backend/app.py` (add import + `.add(...)`).

### Step 2 — Inpainting tool HTML partial

**New file:** `ui/partials/inpaint-tool.html`

A modal dialog containing:

- `<canvas id="inpaint-canvas">` — init image as background, mask as
  semi-transparent red overlay on painted (black) areas
- Brush size slider (`<input type="range">`, e.g. 1–100 px)
- Toggle between **paint** (black = inpaint area) and **erase** (white = keep)
- "Clear Mask" button — resets mask to all-white
- "Undo Last Stroke" button — optional stretch goal
- "Apply Mask" button — exports canvas PNG, POSTs to `/api/inpaint/save-mask`,
  auto-fills `#gen-mask` field via `flagCore.setFlagValue`, closes modal
- "Cancel" button

Wire into `ui/index.html` via `<!-- @partial inpaint-tool -->` (add it
near the other modals or at the end of `<body>`).

### Step 3 — Inpainting tool JavaScript module

**New file:** `ui/js/generate/inpaint-tool.js`

Namespace: `window.SDGui.inpaintTool`

Public API:

| Method | Purpose |
|---|---|
| `init()` | Wire up DOM elements, attach event listeners |
| `open(initImagePath)` | Load init image from `/api/image/<name>`, render to canvas, show modal |
| `close()` | Hide modal, reset state |

Internal state:

- `brushRadius` (int) — current brush size in pixels
- `isPainting` (bool) — whether mouse button is held
- `paintMode` (enum: `"paint"` / `"erase"`) — current tool mode
- `lastX`, `lastY` — previous mouse position for line interpolation
- `origWidth`, `origHeight` — original init image dimensions (used when
  exporting the mask at full resolution)
- `maskData` — offscreen canvas containing the mask pixel data

Drawing logic:

- The visible canvas is sized to fit the modal (max ~800 px on the longest
  side) and shows the init image.  An offscreen canvas of the same display
  size holds the mask (white = keep, black = inpaint).
- On each `mousemove` while painting, draw a filled circle on the mask
  canvas (black for paint mode, white for erase mode) and composite the
  mask as a transparent red tint over the visible canvas.
- Use `requestAnimationFrame` batching to avoid stutter when the brush
  moves quickly — interpolate between `lastX,lastY` and current position
  with small step circles.
- `exportMask()` creates a new offscreen canvas at `origWidth × origHeight`,
  scales the mask canvas up to full resolution (nearest-neighbour for hard
  edges or bilinear for anti-aliased), and returns a PNG data URL.
- `applyMask()` calls `exportMask()`, POSTs the data URL, and on success
  writes the returned path to `flagCore.setFlagValue("mask", path)`, then
  calls `close()`.

DOM safety: use only `createElement`, `textContent`, `replaceChildren`,
`appendChild` — no `innerHTML` with dynamic content (AGENTS.md rule).

### Step 4 — Wire into the Generate tab

**Edit:** `ui/partials/generate-image.html`

Add a "Draw Mask" button next to the existing mask Browse button:

```html
<button id="btn-draw-mask" class="btn btn-sm" type="button">
  Draw Mask
</button>
```

**Edit:** `ui/js/generate-ui.js`

In `bindModeControls()`, wire the "Draw Mask" button to call
`window.SDGui.inpaintTool.open(...)` with the current init image path
from `flagCore.getFlagValues().init_img`.  If no init image is selected,
show a toast: "Select an init image first."

**Edit:** `ui/index.html`

Add `<script src="/js/generate/inpaint-tool.js"></script>` in the script
load block (after `generate-ui.js` so its dependencies are ready).

### Step 5 — End-to-end verification

1. Select an SD 1.5 or SDXL model
2. Set an init image (Browse or pick from gallery)
3. Click "Draw Mask" — verify modal opens with init image displayed
4. Paint some black areas (these will be inpainted)
5. Click "Apply Mask" — verify mask path appears in the mask text field
6. Set a prompt describing what should go in the masked region
7. Set strength (0.75–1.0 for inpainting; 1.0 = full regeneration of masked area)
8. Click Generate — verify the masked region is inpainted and the rest is unchanged

### Step 6 — Optional: inpainting model bundle defaults

**Edit:** `ui/js/flags/model-bundles.js`

Add an "SD 1.5 Inpaint" entry to `MODEL_TYPE_BUNDLES`:

```js
{
  value: "sd1_inpaint",
  label: "SD 1.x Inpaint",
  fields: [{ key: "model", purpose: "model", required: true }],
  defaults: {
    mode: "img_gen",
    width: 512,
    height: 512,
    steps: 20,
    cfg_scale: 7.5,
    strength: 1.0,
    img_cfg_scale: 1.0,
  },
},
```

This pre-fills inpainting-appropriate defaults when the user is working with
a dedicated inpainting model.

## Files Changed (Summary)

| File | Change |
|---|---|
| `backend/routes/inpaint_tool.py` | **New** — mask-save route |
| `backend/app.py` | Add route import + wiring (2 lines) |
| `ui/partials/inpaint-tool.html` | **New** — modal HTML |
| `ui/js/generate/inpaint-tool.js` | **New** — canvas editor module |
| `ui/partials/generate-image.html` | Add "Draw Mask" button (2 lines) |
| `ui/js/generate-ui.js` | Wire Draw Mask button handler (~10 lines) |
| `ui/index.html` | Add script tag for inpaint-tool.js (1 line) |
| `ui/js/flags/model-bundles.js` | Add inpainting bundle (optional, ~12 lines) |

## Verification Checklist

- [ ] `ruff check backend/routes/inpaint_tool.py` passes
- [ ] `node --check ui/js/generate/inpaint-tool.js` passes
- [ ] `python server.py` boots and `curl http://127.0.0.1:5250/api/status` returns OK
- [ ] POST to `/api/inpaint/save-mask` with a valid data URL writes a PNG to `output/.inpaint/`
- [ ] Draw Mask modal opens with init image rendered on canvas
- [ ] Brush paints black areas (visible as red tint)
- [ ] Clear Mask resets to all-white
- [ ] Apply Mask auto-fills the mask text field and closes modal
- [ ] Full generation with init image + mask produces inpainted output
- [ ] UI State Sync Rule: mask field and Configure tab stay in sync
- [ ] No `innerHTML` with dynamic content anywhere in the new module
- [ ] No browser console errors during the paint/apply flow
