// PRIMARY Generate tab: prompt UI, bundle-driven model pickers, mode-specific
// inputs (img2img / upscale / convert / metadata), generate action, live
// preview polling, gallery + history. All state reads/writes go through
// window.SDGui.flagCore (PLAN.md §8 sync rule). Safe DOM only (no innerHTML).
window.SDGui = window.SDGui || {};

window.SDGui.generateUi = (() => {
	var activeGenerateSection = "generate-image";
	var routingSection = false;

	// Stage 2: low-risk pure UI utilities live in dedicated modules under
	// ui/js/generate/. Alias the helpers we use heavily so the call sites
	// stay short. The dimension module is invoked by namespace since its
	// init/setup is wired up explicitly in init() below.
	var dom = window.SDGui.generateDom;
	var dims = window.SDGui.generateDimensions;
	// Stage 3: control binding + the controls/controlMirrors registries live
	// in window.SDGui.generateControls. Alias the bind/sync helpers so call
	// sites stay short; alias the registries (shared by reference — never
	// reassigned, only mutated in place) so model-field pickers, mode inputs,
	// and LoRA controls keep registering into the single shared table.
	var ctrl = window.SDGui.generateControls;
	var bindText = ctrl.bindText;
	var bindNumber = ctrl.bindNumber;
	var bindEnum = ctrl.bindEnum;
	var bindPathSelect = ctrl.bindPathSelect;
	var bindBool = ctrl.bindBool;
	var bindSliderNumber = ctrl.bindSliderNumber;
	var syncControl = ctrl.syncControl;
	var syncControlsFromState = ctrl.syncControlsFromState;
	var syncAll = ctrl.syncAll;
	var controls = ctrl.controls;
	var controlMirrors = ctrl.controlMirrors;
	// Stage 4: bundle-driven model pickers and LoRA controls live in
	// window.SDGui.generateModelFields. We only need renderBundleFields here
	// (called from the bundle select handler, syncFromState, and init). The
	// populateModelSelect export is passed to ctrl.init() below so
	// bindPathSelect can list model folders for path-kind selects (e.g. the
	// upscale-model dropdown). Field labels, the LoRA file select, and the
	// strength slider are owned by the module and re-registered into the
	// shared `controls` table on every renderBundleFields call.
	var mf = window.SDGui.generateModelFields;
	var renderBundleFields = mf.renderBundleFields;
	// Stage 5: history storage (localStorage), rendering, restore/open/
	// delete/clear actions live in window.SDGui.generateHistory. The
	// coordinator still owns the cross-module actions (sendToImg2img,
	// downloadResult, openResultFile) and the mode/flag state restore
	// (syncFromState, switchToModeSection) — they are injected via
	// hist.init() in init() below. addHistoryEntry is forwarded from the
	// live result frame to hist.addHistoryEntry until Stage 7 moves the
	// run controller out.
	var hist = window.SDGui.generateHistory;
	// Stage 6: preview/progress and result-frame rendering are extracted.
	// The coordinator still owns generation polling and injects the few
	// cross-module actions they need.
	var preview = window.SDGui.generatePreviewProgress;
	var results = window.SDGui.generateResults;
	// Stage 7: request construction, polling, cancel, metadata inspect, and
	// generate/cancel button state live in window.SDGui.generateRunController.
	// The coordinator injects mode/routing callbacks and then exposes the same
	// public generate/cancel methods through thin aliases.
	var runner = window.SDGui.generateRunController;
	var generate = runner.generate;
	var cancel = runner.cancel;
	var inspectMetadata = runner.inspectMetadata;
	var downloadResult = results.downloadResult;
	var openResultFile = results.openResultFile;
	var $ = dom.$;
	var setHidden = dom.setHidden;
	var populateEnum = dom.populateEnum;

	var SECTION_CONFIG = {
		"generate-image": {
			mode: "img_gen",
			button: "Generate",
			empty: "Your generated image will appear here.",
			running: "Generating... your image will appear here.",
		},
		"generate-video": {
			mode: "vid_gen",
			button: "Generate video",
			empty: "Your generated video will appear here.",
			running: "Generating... your video will appear here.",
		},
		upscale: {
			mode: "upscale",
			button: "Upscale",
			empty: "Your upscaled image will appear here.",
			running: "Upscaling... your image will appear here.",
		},
		convert: {
			mode: "convert",
			button: "Convert",
			empty: "Conversion output will appear here.",
			running: "Converting... output will appear here.",
		},
	};

	var MODE_SECTION = {
		img_gen: "generate-image",
		metadata: "generate-image",
		vid_gen: "generate-video",
		upscale: "upscale",
		convert: "convert",
	};

	// Mode → mode-inputs container id (which sub-section is visible). Each
	// mode-inputs container holds the file pickers + numeric controls specific
	// to that mode (Phase 3: img2img, upscale, convert, metadata).
	var MODE_INPUT_PANELS = {
		img_gen: "gen-img2img-inputs",
		vid_gen: "gen-video-inputs",
		upscale: "gen-upscale-inputs",
		convert: "gen-convert-inputs",
		metadata: "gen-metadata-inputs",
	};

	// A3/H1 - per-mode label + help text for the mode-inputs section header.
	var MODE_META = {
		img_gen: {
			label: "Image references (optional)",
			help: "Add a reference image for image-to-image, inpainting, or ControlNet.",
		},
		vid_gen: {
			label: "Video inputs (optional)",
			help: "Add a start/end frame image for video generation.",
		},
		upscale: {
			label: "Upscale source",
			help: "Select the image to upscale and a RealESRGAN model.",
		},
		convert: {
			label: "Convert source",
			help: "Source model is selected above; convert writes a GGUF/tensor file.",
		},
		metadata: {
			label: "Inspect image",
			help: "Select an image to read its embedded generation metadata.",
		},
	};

	// ── Stage 1: internal dependency context ───────────────────────────
	// Centralizes the pieces future extracted helper modules (Stage 2+) will
	// receive explicitly, so they never reach back into these closure
	// variables. Mutable section state is exposed via *accessors* (never a
	// captured value) so a helper can never hold a stale activeGenerateSection
	// when the user switches between image/video/upscale/convert/metadata.
	// `controls` and `controlMirrors` are owned by window.SDGui.generateControls
	// (Stage 3) and shared here by reference: they are mutated in place and
	// never reassigned, so reference sharing stays correct.
	var ctx = {
		controls: controls,
		controlMirrors: controlMirrors,
		getActiveSection: () => activeGenerateSection,
		setActiveSection: (section) => {
			activeGenerateSection = section;
		},
		activeConfig: activeConfig,
		switchToModeSection: switchToModeSection,
		syncFromState: syncFromState,
		sendToImg2img: sendToImg2img,
	};

	function sectionForMode(mode) {
		return MODE_SECTION[mode] || "generate-image";
	}

	function activeConfig() {
		return (
			SECTION_CONFIG[ctx.getActiveSection()] || SECTION_CONFIG["generate-image"]
		);
	}

	function moveWorkbenchTo(section) {
		var host = document.querySelector(
			'.generate-tab-host[data-generate-host="' + section + '"]',
		);
		var workbench = $("generate-workbench");
		if (host && workbench && workbench.parentNode !== host) {
			host.appendChild(workbench);
		}
	}

	function switchToModeSection(mode) {
		var section = sectionForMode(mode);
		if (ctx.getActiveSection() === section) return;
		if (window.SDGui.switchSection) {
			routingSection = true;
			window.SDGui.switchSection(section);
			routingSection = false;
		}
	}

	function updateActionCopy() {
		var cfg = activeConfig();
		var genBtn = $("btn-generate");
		if (genBtn) genBtn.textContent = cfg.button;
		var resultEmpty = $("gen-result-empty");
		if (resultEmpty) resultEmpty.textContent = cfg.empty;
	}

	// ── Control binding ────────────────────────────────────────────────────
	// Stage 3: bindText / bindNumber / bindEnum / bindPathSelect / bindBool /
	// bindSliderNumber / syncControl / syncControlsFromState / syncAll (and the
	// controls + controlMirrors registries) now live in
	// window.SDGui.generateControls, loaded before this file. They are aliased
	// at the top of this IIFE so call sites are unchanged.

	// ── Mode-aware section visibility (Phase 3) ────────────────────────────
	function updateModeSections() {
		var mode = window.SDGui.flagCore.getMode();
		var activePanelId = MODE_INPUT_PANELS[mode];
		var sectionMode = activeConfig().mode;
		var imageTab = ctx.getActiveSection() === "generate-image";

		// A3 - relabel the mode-inputs header + help per active mode.
		var label = $("gen-mode-label");
		var help = $("gen-mode-help");
		var meta = MODE_META[mode === "metadata" ? "metadata" : sectionMode];
		if (label && meta) label.textContent = meta.label;
		if (help && meta) help.textContent = meta.help;
		var helpWrap = $("gen-mode-inputs");
		if (helpWrap && help) help.style.display = meta && meta.help ? "" : "none";

		// Toggle which mode-inputs panel is visible.
		Object.keys(MODE_INPUT_PANELS).forEach((m) => {
			var panelId = MODE_INPUT_PANELS[m];
			var visible = panelId === activePanelId;
			if (imageTab && mode === "img_gen" && panelId === "gen-metadata-inputs") {
				visible = true;
			}
			setHidden($(panelId), !visible);
		});

		// Prompt + negative prompt + dimensions/steps/seed are only relevant
		// for img_gen / vid_gen (and not for upscale/convert/metadata).
		var usePrompt = mode === "img_gen" || mode === "vid_gen";
		setHidden($("gen-prompt-section"), !usePrompt);
		setHidden($("gen-sampling-section"), !usePrompt);
		setHidden($("gen-advanced-section"), !usePrompt);

		// Refresh shape/size highlights + live readout for the current size (A6).
		dims.updateAffordances();
		updateActionCopy();
	}

	// ── Model-component pickers (bundle-driven) ───────────────────────────
	// Stage 4: fieldLabel, populateModelSelect, populateLoraFileSelect,
	// renderLoraControls, browseModel, and renderBundleFields now live in
	// window.SDGui.generateModelFields. renderBundleFields is aliased at the
	// top of this IIFE so call sites below (bundle select handler,
	// syncFromState, init, and the public return) are unchanged.

	function syncSelectorsFromState() {
		var bundleSelect = $("gen-model-bundle");
		if (bundleSelect) bundleSelect.value = window.SDGui.flagCore.getBundle();
	}

	function syncFromState(renderFields) {
		switchToModeSection(window.SDGui.flagCore.getMode());
		syncSelectorsFromState();
		updateModeSections();
		if (renderFields) renderBundleFields();
		syncAll();
	}

	// ── Phase 3: Browse for non-bundle file pickers (init_img / mask /
	// control_image / upscale-init / upscale-model / metadata image).
	async function browsePath(flagId, purpose, title) {
		try {
			var res = await window.SDGui.fetchJson("/api/select-file", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ purpose: purpose, title: title }),
			});
			if (res && res.selected && res.path) {
				window.SDGui.flagCore.setFlagValue(flagId, res.path);
				syncControl(flagId);
			}
		} catch (e) {
			window.SDGui.toast(e.message, "error");
		}
	}

	function bindBrowse(buttonId, handler) {
		var btn = $(buttonId);
		if (btn) btn.addEventListener("click", handler);
	}

	// ── History (localStorage) ────────────────────────────────────────────
	// Stage 5: load/save/render/restore/open/delete/clear all live in
	// window.SDGui.generateHistory (init() injects the cross-module
	// actions). The coordinator exposes a `renderHistory` alias for any
	// external caller and forwards new entries from the live result frame
	// via `hist.addHistoryEntry`.

	// ── Generation flow ───────────────────────────────────────────────────
	function sendToImg2img(name) {
		if (!name) return;
		// Result files live under output/ (sd-cli runs with cwd = project root),
		// so prefix the bare filename so --init-img resolves at generate time.
		var initPath = "output/" + String(name).replace(/^\/+/, "");
		window.SDGui.flagCore.setFlagValue("init_img", initPath);
		// img2img is an img_gen-only feature; switch modes if needed.
		if (window.SDGui.flagCore.getMode() !== "img_gen") {
			window.SDGui.flagCore.setMode("img_gen");
		}
		switchToModeSection("img_gen");
		updateModeSections();
		syncAll();
		// The init-image field sits inside a collapsed <details> disclosure;
		// expand it (and focus the field) so the action is visibly applied.
		var initInput = $("gen-init-img");
		var details = initInput ? initInput.closest("details") : null;
		if (details) details.open = true;
		if (initInput) initInput.focus();
		window.SDGui.toast(
			"Set as init image. Adjust strength then Generate.",
			"info",
		);
	}

	function handleSectionChange(section) {
		if (!SECTION_CONFIG[section]) return;
		ctx.setActiveSection(section);
		moveWorkbenchTo(section);
		var desiredMode = SECTION_CONFIG[section].mode;
		if (!routingSection && window.SDGui.flagCore.getMode() !== desiredMode) {
			window.SDGui.flagCore.setMode(desiredMode);
		}
		syncSelectorsFromState();
		updateModeSections();
		syncAll();
	}

	function init() {
		// Stage 4: hand the model-fields module its shared dependencies
		// (flagCore + the controls registry + syncControl) so it can register
		// path-kind controls and prune stale ones on bundle re-renders. Must
		// run before any renderBundleFields() call below.
		mf.init({
			flagCore: window.SDGui.flagCore,
			controls: controls,
			syncControl: syncControl,
		});
		// Stage 3: hand the control-binding registry its flagCore + the model
		// select populator (now exported by window.SDGui.generateModelFields
		// since Stage 4). bindPathSelect uses this to fill the upscale-model
		// dropdown from /api/models?type=upscaler. Must run before any
		// bind*() call below.
		ctrl.init({
			flagCore: window.SDGui.flagCore,
			populateModelSelect: mf.populateModelSelect,
		});
		// Stage 6: preview/progress and result-frame rendering are pure UI
		// modules. The run lifecycle stays here until Stage 7, but delegates
		// visible preview/result effects through these exports.
		preview.init({ flagCore: window.SDGui.flagCore });
		results.init({
			flagCore: window.SDGui.flagCore,
			history: hist,
			previewProgress: preview,
			sendToImg2img: sendToImg2img,
		});
		runner.init({
			flagCore: window.SDGui.flagCore,
			previewProgress: preview,
			results: results,
			activeConfig: activeConfig,
			syncFromState: syncFromState,
			updateModeSections: updateModeSections,
		});
		// Stage 5: hand the history module its flagCore + the cross-module
		// actions it needs (sendToImg2img / downloadResult / openResultFile
		// for opening a history image in the result frame, and
		// syncFromState / switchToModeSection for restoring a history
		// entry's mode + flagCore + bundle). Must run before any
		// hist.addHistoryEntry / hist.render() call below.
		hist.init({
			flagCore: window.SDGui.flagCore,
			sendToImg2img: sendToImg2img,
			downloadResult: downloadResult,
			openResultFile: openResultFile,
			syncFromState: syncFromState,
			switchToModeSection: switchToModeSection,
		});
		moveWorkbenchTo(ctx.getActiveSection());
		// Generate defaults: enable live preview (sd-cli defaults to none).
		var vals = window.SDGui.flagCore.getFlagValues();
		if (!vals.preview || vals.preview === "none") {
			window.SDGui.flagCore.setFlagValue(
				"preview",
				window.SDGui.DEFAULT_PREVIEW_METHOD || "vae",
			);
		}

		// Populate enum selects from the canonical option lists.
		populateEnum(
			"gen-sampler",
			window.SDGui.SAMPLING_METHODS,
			vals.sampling_method,
		);
		populateEnum("gen-scheduler", window.SDGui.SCHEDULERS, vals.scheduler);
		populateEnum("gen-type", window.SDGui.WEIGHT_TYPES, vals.type);
		populateEnum(
			"gen-preview-method",
			window.SDGui.PREVIEW_METHODS,
			vals.preview,
		);

		// Bundle dropdown.
		var bundleSelect = $("gen-model-bundle");
		if (bundleSelect) {
			bundleSelect.replaceChildren();
			(window.SDGui.MODEL_TYPE_BUNDLES || []).forEach((b) =>
				bundleSelect.appendChild(new Option(b.label, b.value)),
			);
			bundleSelect.value = window.SDGui.flagCore.getBundle();
			bundleSelect.addEventListener("change", () => {
				window.SDGui.flagCore.setBundle(bundleSelect.value, true);
				// applyBundleDefaults may switch the mode (e.g. wan -> vid_gen);
				// route the shared workbench to the matching top-level tab.
				switchToModeSection(window.SDGui.flagCore.getMode());
				updateModeSections();
				renderBundleFields();
				syncAll();
			});
		}

		// Bind core controls.
		bindText("gen-prompt", "prompt");
		bindText("gen-negative", "negative_prompt");
		bindNumber("gen-width", "width");
		bindNumber("gen-height", "height");
		// A7 — continuous params as slider + number compounds.
		bindSliderNumber("gen-steps", "steps", 1, 150, 1, false);
		bindSliderNumber("gen-cfg", "cfg_scale", 0, 30, 0.1, true);
		bindEnum("gen-sampler", "sampling_method");
		bindEnum("gen-scheduler", "scheduler");
		bindNumber("gen-seed", "seed");
		bindNumber("gen-batch", "batch_count");
		bindNumber("gen-threads", "threads");
		bindEnum("gen-type", "type");
		bindEnum("gen-preview-method", "preview");
		bindNumber("gen-preview-interval", "preview_interval");
		bindBool("gen-offload", "offload_to_cpu");
		bindBool("gen-clip-cpu", "clip_on_cpu");
		bindBool("gen-flash", "flash_attn");
		bindBool("gen-vae-tiling", "vae_tiling");

		// img2img / vid_gen mode inputs.
		bindText("gen-init-img", "init_img");
		bindBrowse("btn-browse-init-img", () =>
			browsePath("init_img", "image", "Select init image"),
		);
		bindNumber("gen-control-strength", "control_strength", true);
		bindText("gen-mask", "mask");
		bindBrowse("btn-browse-mask", () =>
			browsePath("mask", "image", "Select mask image"),
		);
		bindText("gen-control-image", "control_image");
		bindBrowse("btn-browse-control-image", () =>
			browsePath("control_image", "image", "Select control image"),
		);
		bindNumber("gen-video-frames", "video_frames");
		bindNumber("gen-fps", "fps");
		bindNumber("gen-vace-strength", "vace_strength", true);
		bindBool("gen-temporal-tiling", "temporal_tiling");
		// Video start/end frames (image-to-video first frame; flf2v last frame).
		// init_img shares state with the img2img panel (registered there first, so
		// this binding becomes a mirror — both inputs read the same flagCore state).
		bindText("gen-video-init-img", "init_img");
		bindBrowse("btn-browse-video-init-img", () =>
			browsePath("init_img", "image", "Select start frame"),
		);
		bindText("gen-video-end-img", "end_img");
		bindBrowse("btn-browse-video-end-img", () =>
			browsePath("end_img", "image", "Select end frame"),
		);

		// Upscale mode inputs (init_img shares state with img2img init_img).
		bindText("gen-upscale-init-img", "init_img");
		bindBrowse("btn-browse-upscale-init-img", () =>
			browsePath("init_img", "image", "Select init image"),
		);
		bindPathSelect("gen-upscale-model", "upscale_model", "upscaler");
		bindBrowse("btn-browse-upscale-model", () =>
			browsePath("upscale_model", "upscaler", "Select upscaler model"),
		);
		bindNumber("gen-upscale-repeats", "upscale_repeats");
		bindNumber("gen-upscale-tile-size", "upscale_tile_size");

		// Convert mode inputs.
		bindText("gen-convert-name", "convert_name");

		// Metadata mode inputs.
		bindText("gen-metadata-image", "image");
		bindBrowse("btn-browse-metadata-image", () =>
			browsePath("image", "image", "Select image"),
		);
		bindEnum("gen-metadata-format", "metadata_format");

		syncControlsFromState();
		updateModeSections();

		// Buttons.
		var genBtn = $("btn-generate");
		if (genBtn) genBtn.addEventListener("click", generate);
		var cancelBtn = $("btn-generate-cancel");
		if (cancelBtn) cancelBtn.addEventListener("click", cancel);
		var metadataBtn = $("btn-inspect-metadata");
		if (metadataBtn) metadataBtn.addEventListener("click", inspectMetadata);

		// A6 — dimension widget (shape/size chips + W/H swap + snap-to-multiple).
		// Stage 2: the entire widget lives in window.SDGui.generateDimensions.
		// We pass flagCore + syncAll so the widget can write shared state
		// (Configure tab sync) and refresh non-focused controls after a
		// local mutation. The widget also paints the initial readout.
		dims.init({ flagCore: window.SDGui.flagCore, onSyncAll: syncAll });

		// A5 — randomize seed button.
		var seedBtn = $("btn-random-seed");
		if (seedBtn) {
			seedBtn.addEventListener("click", () => {
				var seed = Math.floor(Math.random() * 2147483647);
				window.SDGui.flagCore.setFlagValue("seed", seed);
				var seedInput = $("gen-seed");
				if (seedInput) seedInput.value = String(seed);
			});
		}

		// A4 — Ctrl/Cmd+Enter to generate from the prompt or the panel.
		document.querySelectorAll(".generate-tab-host").forEach((generatePanel) => {
			generatePanel.addEventListener("keydown", (e) => {
				if (
					(e.ctrlKey || e.metaKey) &&
					(e.key === "Enter" || e.code === "Enter")
				) {
					e.preventDefault();
					generate();
				}
			});
		});

		// Cross-tab / cross-control sync: refresh non-focused controls on change.
		window.SDGui.flagCore.onChange(() => {
			syncFromState(false);
		});

		renderBundleFields();
		// Stage 5: history is owned by window.SDGui.generateHistory. The
		// module renders + wires the clear/show-more toolbar via
		// hist.attachToolbar() (single DOM contract for the
		// clear-confirmation + show-more toggle).
		hist.render();
		updateActionCopy();
		hist.attachToolbar();

		// If a generation is already running (page reload), resume polling.
		runner.resumeIfRunning();
	}

	return {
		init: init,
		renderBundleFields: renderBundleFields,
		generate: generate,
		cancel: cancel,
		// Stage 5: history is owned by window.SDGui.generateHistory; the
		// public method is now a thin alias onto hist.render so any
		// external caller (and the existing tests' contract) keeps working.
		renderHistory: hist.render,
		updateModeSections: updateModeSections,
		syncFromState: syncFromState,
		handleSectionChange: handleSectionChange,
	};
})();
