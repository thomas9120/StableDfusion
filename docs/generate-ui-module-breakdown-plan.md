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

### Stage 2: Extract Low-Risk Pure UI Utilities — ✅ DONE (2026-06-20)

Created three new modules under `ui/js/generate/`, loaded before
`generate-ui.js` in `ui/index.html`:

- `ui/js/generate/dom.js` (`window.SDGui.generateDom`) — `$`, `el`,
  `setHidden`, `populateEnum`. Pure DOM utilities, no state.
- `ui/js/generate/formatters.js` (`window.SDGui.generateFormatters`) —
  `formatElapsed`, `relativeTime`, `loraNameFromPath`,
  `loraFolderFromPath`, `formatLoraStrength`. Pure functions, no DOM,
  no flagCore.
- `ui/js/generate/dimensions.js` (`window.SDGui.generateDimensions`) —
  the full "Aspect → Size" widget: shape chips, size buttons, live
  readout, proportional preview swatch, exact W/H snap-to-multiple, and
  the W/H swap button. Exposes `init({ flagCore, onSyncAll })`,
  `updateAffordances()`, and `snapInputs()`. Module-private state
  (`lastShape`, `DIM_MULTIPLE`) is encapsulated; all state mutations
  route through the injected `flagCore` so Configure tab sync is
  preserved.

`generate-ui.js` now aliases the small helpers (`$`, `el`, `setHidden`,
`populateEnum`, `formatElapsed`, `relativeTime`, `loraNameFromPath`,
`loraFolderFromPath`, `formatLoraStrength`) onto the new module exports
so the call sites stayed short, and the dimension widget is wired up via
`dims.init({ flagCore, onSyncAll: syncAll })` in `init()`. The
`updateModeSections` mode-routing path now calls
`dims.updateAffordances()` to refresh the readout.

Result: `generate-ui.js` dropped from 1727 to 1467 lines (~260 lines
moved out, no behavior change). Verified: `node --check` (21 files,
all ok), `npm run test:syntax`, `npm run test:frontend` (incl. the
dimension bucket + manual-edit-returns-to-Custom checks and the full
init_img mirror suite), and `python server.py` + `/api/status` all
pass.

### Stage 3: Extract Control Binding as a Shared Registry — ✅ DONE (2026-06-20)

Created `ui/js/generate/control-bindings.js`
(`window.SDGui.generateControls`), loaded after `dimensions.js` and before
`generate-ui.js` in `ui/index.html`. The new module **owns** the
`controls` and `controlMirrors` registries (exposed for direct registration
by model-field pickers, mode inputs, and LoRA controls) and hosts all the
binding/sync functions moved out of the coordinator: `bindText`,
`bindNumber`, `bindEnum`, `bindPathSelect`, `bindBool`, `bindSliderNumber`,
`syncControl`, `syncControlsFromState`, `syncAll`.

`generate-ui.js` now aliases the helpers and the two registries at the top
of its IIFE (`var controls = ctrl.controls`, shared by reference), so every
call site — including the bundle re-render that deletes stale `path`
controls and the LoRA `controls.lora_*` assignments — works unchanged
against the single shared table. `bindPathSelect` depends on
`populateModelSelect` (still coordinator-owned until Stage 4), so it is
injected via `ctrl.init({ flagCore, populateModelSelect })` at the top of
`init()`, avoiding a circular dependency with the future model-fields
module.

Result: `generate-ui.js` dropped from 1467 to 1336 lines (~131 lines
moved out, no behavior change). Verified: `node --check` (22 files, all
ok), `npm run test:syntax`, `npm run test:frontend` (incl. the `init_img`
primary+mirror sync suite, the upscale `bindPathSelect` dropdown listing
the upscalers folder, LoRA slider + prompt-tag injection, and the
wan→vid_gen bundle switch that exercises stale path-control cleanup),
`ruff check .`, and `python server.py` + `/api/status` all pass.

#### Original plan (kept for reference)

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

### Stage 4: Extract Model Fields and LoRA Controls — ✅ DONE (2026-06-20)

Created `ui/js/generate/model-fields.js` (`window.SDGui.generateModelFields`),
loaded after `control-bindings.js` and before `generate-ui.js` in
`ui/index.html`. The new module **owns** the bundle-driven model pickers
and LoRA controls: `fieldLabel`, `populateModelSelect`,
`populateLoraFileSelect`, `renderLoraControls`, `browseModel`, and
`renderBundleFields`.

`generate-ui.js` now aliases the helper at the top of its IIFE
(`var mf = window.SDGui.generateModelFields`,
`var renderBundleFields = mf.renderBundleFields`) so every call site —
the bundle select change handler, `syncFromState`, `init`, and the public
return — works unchanged. `mf.init({ flagCore, controls, syncControl })`
runs first in `init()` so the module can register path-kind controls and
prune stale entries on bundle re-renders. `populateModelSelect` is
re-injected into `ctrl.init({ populateModelSelect: mf.populateModelSelect })`
so `bindPathSelect("gen-upscale-model", ...)` still populates the
upscaler dropdown from `/api/models?type=upscaler` (the test suite
asserts the rendered option list).

The LoRA prompt-tag injection (`<lora:name:strength>` +
`--lora-model-dir`) intentionally stays in `generate()` (will move to
the run controller in Stage 7) so the path-parsing helpers in
`window.SDGui.generateFormatters` remain the single source of truth for
LoRA-path → prompt-tag transformation.

Result: `generate-ui.js` dropped from 1336 to 1034 lines (~302 lines
moved out, no behavior change). Verified: `node --check` (23 files, all
ok), `npm run test:syntax`, `npm run test:frontend` (incl. the LoRA
strength slider render, the LoRA prompt-tag + `--lora-model-dir`
injection at generate time, the `init_img` mirror suite, the wan→vid_gen
bundle re-render, and the upscale-model dropdown listing the upscalers
folder), and `python server.py` + `/api/status` all pass.

#### Original plan (kept for reference)

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
