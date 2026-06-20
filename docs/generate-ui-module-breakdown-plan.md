# Generate UI Module Breakdown Plan

## Recommendation

Yes, `ui/js/generate-ui.js` is worth breaking down into smaller modules.

The file is currently about 1,700 lines and owns several distinct responsibilities:

- Generate section routing and mode visibility.
- Shared control binding and `flagCore` synchronization.
- Dimension preset UI and snapping behavior.
- Bundle-driven model component pickers.
- LoRA helper UI.
- Native file browsing for mode-specific paths.
- Local history storage, restore, open, delete, and clear actions.
- Live preview rendering for both images and videos.
- Generation request construction, polling, progress, terminal states, and result actions.
- Main `init()` orchestration for all of the above.

This is still understandable because it is written in a consistent style, but it has crossed the point where unrelated changes are likely to collide. The best reason to split it now is not aesthetics; it is to protect the Generate tab as more Phase 6 features land, especially video controls, per-tab history filtering, LoRA/ControlNet/PhotoMaker/PuLID panels, and advanced backend tuning.

The split should preserve the project's current frontend architecture: ordered global scripts, no bundler, no ES modules, and public APIs attached under `window.SDGui.*`.

## Current Constraints

- `ui/index.html` loads frontend files as ordered global `<script>` tags.
- `generate-ui.js` currently loads before `gallery-rendering.js`, but it only calls `window.SDGui.gallery` after initialization/user actions, so that ordering works today.
- Shared state must continue to flow through `window.SDGui.flagCore`; no extracted module should mutate flag values directly.
- The Generate tab and Configure tab share settings, so extraction must not introduce a separate Generate-only state store for flags.
- DOM access is id-based and tightly coupled to `ui/index.html`; modules should be thin DOM controllers rather than generic libraries.
- Dynamic content must keep using safe DOM APIs (`textContent`, `createElement`, `replaceChildren`, `new Option`) and avoid `innerHTML`.

## Proposed Target Shape

Keep `window.SDGui.generateUi` as the public coordinator. Move focused behavior into helper modules loaded before it.

Suggested script order:

1. Existing flag/model/core modules.
2. `gallery-rendering.js`.
3. New Generate helper modules.
4. `generate-ui.js` as the final Generate coordinator.
5. The rest of the app modules.

Suggested files:

| File | Namespace | Responsibility |
|---|---|---|
| `ui/js/generate/dom.js` | `window.SDGui.generateDom` | Small shared DOM helpers: `$`, `el`, `setHidden`, maybe `populateEnum`. |
| `ui/js/generate/dimensions.js` | `window.SDGui.generateDimensions` | Dimension buckets UI, aspect/size button rendering, snapping, budget label, preview swatch. |
| `ui/js/generate/control-bindings.js` | `window.SDGui.generateControls` | `bindText`, `bindNumber`, `bindEnum`, `bindBool`, `bindSliderNumber`, `syncControl`, mirrors, and `syncAll`. |
| `ui/js/generate/model-fields.js` | `window.SDGui.generateModelFields` | Bundle field labels, `/api/models` select population, browse model, LoRA controls, `renderBundleFields`. |
| `ui/js/generate/history.js` | `window.SDGui.generateHistory` | LocalStorage schema, history rendering, restore/open/delete/clear actions. |
| `ui/js/generate/preview-progress.js` | `window.SDGui.generatePreviewProgress` | Preview image/video switching, progress bar, elapsed/ETA formatting, empty result frame. |
| `ui/js/generate/results.js` | `window.SDGui.generateResults` | Result rendering, stderr/warnings, result action wiring, download/open/send-to-img2img helpers. |
| `ui/js/generate/run-controller.js` | `window.SDGui.generateRunController` | Generate request body construction, LoRA prompt injection, polling, cancel, metadata inspect. |
| `ui/js/generate-ui.js` | `window.SDGui.generateUi` | Owns active section/mode, init sequence, cross-module wiring, public methods used by `app.js`. |

The exact filenames can change, but the important boundary is: stateful shared control registration in one place, backend run lifecycle in one place, and visual/history/result concerns outside the coordinator.

## Staged Plan

### Stage 1: Make Dependencies Explicit — ✅ DONE (2026-06-20)

Added an internal `ctx` object inside the `generate-ui.js` IIFE (no code moved). Mutable section state is exposed via accessors (`getActiveSection`/`setActiveSection`) rather than captured values, and the coordinator now routes all `activeGenerateSection` reads/writes through those accessors so the variable has a single owner. `controls`/`controlMirrors` are shared by reference. Verified: `node --check`, `npm run test:syntax`, `npm run test:frontend` (incl. `init_img` mirror + mode-routing checks), and `python server.py` + `/api/status` all pass.

Before moving code, add a small internal context object inside `generate-ui.js` and pass it to extracted helpers later. The context should centralize:

- `controls`.
- `controlMirrors`.
- `getActiveSection` / `setActiveSection` or equivalent.
- `activeConfig()`.
- `switchToModeSection()`.
- `syncFromState()`.
- Shared actions such as `sendToImg2img`, if they remain coordinator-owned.

This avoids extracted modules reaching back into private closure variables through awkward global assumptions.

Pitfall: if helpers capture stale copies of `activeGenerateSection` or mode values, section changes between image/video/upscale/convert can desynchronize the workbench and controls.

### Stage 2: Extract Low-Risk Pure UI Utilities

Start with the least coupled code:

- DOM helpers.
- Formatting helpers (`formatElapsed`, `relativeTime`, LoRA name/strength helpers).
- Dimension UI.

`generateDimensions` should expose something like:

- `init({ flagCore, onSyncAll })`.
- `updateAffordances()`.
- `snapInputs()`.

Pitfall: dimension controls are linked to `flagCore` and `syncAll()`. If the extracted module updates DOM without going through `flagCore.setFlagValue` or `setMultipleFlagValues`, Configure tab sync will regress.

### Stage 3: Extract Control Binding as a Shared Registry

Move the binding/sync functions together:

- `bindText`.
- `bindNumber`.
- `bindEnum`.
- `bindPathSelect`.
- `bindBool`.
- `bindSliderNumber`.
- `syncControl`.
- `syncControlsFromState` / `syncAll`.

This module should own the `controls` and `controlMirrors` registries, or receive them from the coordinator. Owning them in one module is cleaner because model fields, mode inputs, and LoRA controls all register controls.

Pitfall: dynamic bundle fields currently delete stale `path` controls before re-rendering. That cleanup must remain correct or hidden model picker controls can continue to receive state updates.

### Stage 4: Extract Model Fields and LoRA Controls

Move:

- `fieldLabel`.
- `populateModelSelect`.
- `browseModel`.
- `renderBundleFields`.
- LoRA file select and strength slider helpers.

This module should depend on:

- `window.SDGui.fetchJson`.
- `window.SDGui.flagCore`.
- `window.SDGui.getBundle`.
- `window.SDGui.BUNDLE_FIELD_PURPOSES`.
- The control binding module.

Pitfall: LoRA generation behavior is split today: the controls live near model fields, but prompt injection happens in `generate()`. Keep the transformation testable and avoid duplicating LoRA parsing in two modules.

### Stage 5: Extract History

Move:

- `loadHistory`.
- `saveHistory`.
- `renderHistory`.
- `restoreFromHistory`.
- `openHistoryImage`.
- `removeHistoryEntry`.
- `clearHistory`.

The history module should accept callbacks for actions that belong elsewhere:

- `sendToImg2img(name)`.
- `downloadResult(name)`.
- `openResultFile()`.
- `syncFromState(renderFields)`.
- `switchToModeSection(mode)`.

Pitfall: history entries are persisted in localStorage. Preserve the current schema (`id`, `name`, `file`, `prompt`, `thumb`, `timestamp`, `bundle`, `mode`, `params`) and keep backward compatibility for older entries that only have `name`.

### Stage 6: Extract Preview, Progress, and Results

Move preview/progress first:

- `resetPreview`.
- `refreshPreview`.
- image/video preview switching.
- progress bar helpers.
- `updateProgress`.
- `showResultEmpty`.

Then move result rendering:

- `renderResult`.
- `renderResultError`.
- `downloadResult`.
- `openResultFile`.
- result action wiring.

Pitfall: video handling is subtle. `vid_gen` preview uses a `<video>`, image modes use `<img>`, and result actions hide "Send to img2img" for video files. Keep this behavior in one module or provide a single `isVideoFile` dependency from `gallery-rendering.js`.

### Stage 7: Extract Run Controller

Move the backend lifecycle last:

- `generate`.
- `poll`.
- `startPolling`.
- `stopPolling`.
- `cancel`.
- `inspectMetadata`.
- `setGenerating`.

This module should receive callbacks for UI effects:

- `resetPreview`.
- `refreshPreview`.
- `updateProgress`.
- `renderResult`.
- `renderResultError`.
- `showResultEmpty`.
- `renderHistory`.
- `syncFromState`.

Pitfall: `inspectMetadata()` temporarily switches mode to `metadata` and then restores the previous mode. That behavior crosses run lifecycle, mode routing, and result rendering, so it should be covered by tests before extraction.

### Stage 8: Reduce `generate-ui.js` to Coordination

After extraction, `generate-ui.js` should mostly contain:

- Section config constants.
- Mode-to-section mapping.
- `moveWorkbenchTo`.
- `switchToModeSection`.
- `updateModeSections`.
- `syncFromState`.
- `handleSectionChange`.
- `init`.
- Public exports expected by `app.js`.

The coordinator may still be a few hundred lines. That is fine. The goal is not tiny files; the goal is clear ownership.

## Recommended First Split

The safest first implementation pass would create only three modules:

1. `generate/control-bindings.js`.
2. `generate/model-fields.js`.
3. `generate/history.js`.

These are the most likely to grow independently, and extracting them would remove a large amount of code without disturbing polling/result timing too early.

Leave generation polling and result rendering in `generate-ui.js` until after the first split is stable. Those paths are user-visible and easier to regress.

## Potential Pitfalls

- Load order regressions: helper modules must load before `generate-ui.js`; `gallery-rendering.js` should load before modules that call `window.SDGui.gallery` during init.
- Hidden global coupling: extracted modules should not depend on private closure variables from `generate-ui.js`; pass callbacks or use explicit namespaces.
- Duplicate state: do not create a separate control value store. `flagCore` remains the source of truth.
- Direct mutation: no module should mutate `flagCore.getFlagValues()` results directly.
- Stale controls: bundle re-rendering must remove or ignore disconnected path selects.
- Mirror controls: `init_img` appears in multiple panels; mirror sync must survive extraction.
- Mode routing loops: `switchToModeSection`, `handleSectionChange`, and `flagCore.setMode` can trigger each other. Preserve the current `routingSection` guard or replace it deliberately.
- History compatibility: old localStorage entries should still open or restore gracefully.
- Video/image branching: preview and result rendering must keep image and video modes separate without leaking video controls into image mode.
- Metadata mode: it produces text output rather than image files; result/history logic must keep handling that special case.
- LoRA prompt injection: adding `<lora:name:strength>` at generation time should not permanently mutate the prompt field unless that is intentionally changed.
- Test fragility: Playwright/smoke tests may depend on current ids and timing; module extraction should preserve DOM ids and public `window.SDGui.generateUi` methods.

## Verification Plan

After each extraction stage:

- Run `node --check` on every touched JS file.
- Run `npm run test:syntax`.
- Run `npm run test:frontend`.
- Start the backend with `python server.py`.
- Confirm `curl http://127.0.0.1:5250/api/status` works.
- Smoke in the browser with `ui/` served as web root.

Manual Generate checks to preserve:

- Generate image: prompt, preview update, progress, result, history entry.
- Generate video: video preview/result, no "Send to img2img" action.
- Upscale: shared `init_img` mirror still syncs.
- Convert and metadata modes: correct visible controls and terminal output.
- History restore: restores mode, bundle, params, and rerenders bundle fields.
- Configure sync: changing dimensions/seed in Generate updates shared flag state used by Configure.

## Not Recommended

- Do not switch this one area to ES modules or a bundler unless the whole app adopts that direction.
- Do not split by arbitrary line count. Split by ownership and dependency direction.
- Do not move `flagCore` responsibilities into Generate modules.
- Do not combine this refactor with new video/ControlNet/LoRA feature work. Extract first, then add features.

## Bottom Line

Break it down, but do it gradually. The file has become a working "mini app" inside the app; the next features will be much easier to add if control binding, model fields, history, preview/progress, results, and run lifecycle each have a clear home. Keep `generate-ui.js` as the coordinator and preserve the existing ordered global script architecture.
