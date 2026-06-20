// PRIMARY Generate tab coordinator.
// Keeps section routing, module wiring, and public methods used by app.js.
// Feature ownership lives in ui/js/generate/* modules. All shared setting
// reads/writes go through window.SDGui.flagCore.
window.SDGui = window.SDGui || {};

window.SDGui.generateUi = (() => {
	var activeGenerateSection = "generate-image";
	var routingSection = false;

	var dom = window.SDGui.generateDom;
	var dims = window.SDGui.generateDimensions;
	var ctrl = window.SDGui.generateControls;
	var mf = window.SDGui.generateModelFields;
	var hist = window.SDGui.generateHistory;
	var preview = window.SDGui.generatePreviewProgress;
	var results = window.SDGui.generateResults;
	var runner = window.SDGui.generateRunController;

	var $ = dom.$;
	var setHidden = dom.setHidden;
	var populateEnum = dom.populateEnum;

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

	var renderBundleFields = mf.renderBundleFields;
	var generate = runner.generate;
	var cancel = runner.cancel;
	var inspectMetadata = runner.inspectMetadata;
	var downloadResult = results.downloadResult;
	var openResultFile = results.openResultFile;

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

	var MODE_INPUT_PANELS = {
		img_gen: "gen-img2img-inputs",
		vid_gen: "gen-video-inputs",
		upscale: "gen-upscale-inputs",
		convert: "gen-convert-inputs",
		metadata: "gen-metadata-inputs",
	};

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

	function sectionForMode(mode) {
		return MODE_SECTION[mode] || "generate-image";
	}

	function activeConfig() {
		return SECTION_CONFIG[activeGenerateSection] || SECTION_CONFIG["generate-image"];
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
		if (activeGenerateSection === section) return;
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

	function updateModeSections() {
		var mode = window.SDGui.flagCore.getMode();
		var activePanelId = MODE_INPUT_PANELS[mode];
		var sectionMode = activeConfig().mode;
		var imageTab = activeGenerateSection === "generate-image";

		var label = $("gen-mode-label");
		var help = $("gen-mode-help");
		var meta = MODE_META[mode === "metadata" ? "metadata" : sectionMode];
		if (label && meta) label.textContent = meta.label;
		if (help && meta) help.textContent = meta.help;
		var helpWrap = $("gen-mode-inputs");
		if (helpWrap && help) help.style.display = meta && meta.help ? "" : "none";

		Object.keys(MODE_INPUT_PANELS).forEach((m) => {
			var panelId = MODE_INPUT_PANELS[m];
			var visible = panelId === activePanelId;
			if (imageTab && mode === "img_gen" && panelId === "gen-metadata-inputs") {
				visible = true;
			}
			setHidden($(panelId), !visible);
		});

		var usePrompt = mode === "img_gen" || mode === "vid_gen";
		setHidden($("gen-prompt-section"), !usePrompt);
		setHidden($("gen-sampling-section"), !usePrompt);
		setHidden($("gen-advanced-section"), !usePrompt);

		dims.updateAffordances();
		updateActionCopy();
	}

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

	function sendToImg2img(name) {
		if (!name) return;
		var initPath = "output/" + String(name).replace(/^\/+/, "");
		window.SDGui.flagCore.setFlagValue("init_img", initPath);
		if (window.SDGui.flagCore.getMode() !== "img_gen") {
			window.SDGui.flagCore.setMode("img_gen");
		}
		switchToModeSection("img_gen");
		updateModeSections();
		syncAll();

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
		activeGenerateSection = section;
		moveWorkbenchTo(section);
		var desiredMode = SECTION_CONFIG[section].mode;
		if (!routingSection && window.SDGui.flagCore.getMode() !== desiredMode) {
			window.SDGui.flagCore.setMode(desiredMode);
		}
		syncSelectorsFromState();
		updateModeSections();
		syncAll();
	}

	function initModules() {
		mf.init({
			flagCore: window.SDGui.flagCore,
			controls: controls,
			syncControl: syncControl,
		});
		ctrl.init({
			flagCore: window.SDGui.flagCore,
			populateModelSelect: mf.populateModelSelect,
		});
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
		hist.init({
			flagCore: window.SDGui.flagCore,
			sendToImg2img: sendToImg2img,
			downloadResult: downloadResult,
			openResultFile: openResultFile,
			syncFromState: syncFromState,
			switchToModeSection: switchToModeSection,
		});
	}

	function ensurePreviewDefault() {
		var vals = window.SDGui.flagCore.getFlagValues();
		if (!vals.preview || vals.preview === "none") {
			window.SDGui.flagCore.setFlagValue(
				"preview",
				window.SDGui.DEFAULT_PREVIEW_METHOD || "vae",
			);
		}
		return vals;
	}

	function populateStaticSelects(vals) {
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
	}

	function setupBundleSelect() {
		var bundleSelect = $("gen-model-bundle");
		if (!bundleSelect) return;
		bundleSelect.replaceChildren();
		(window.SDGui.MODEL_TYPE_BUNDLES || []).forEach((b) =>
			bundleSelect.appendChild(new Option(b.label, b.value)),
		);
		bundleSelect.value = window.SDGui.flagCore.getBundle();
		bundleSelect.addEventListener("change", () => {
			window.SDGui.flagCore.setBundle(bundleSelect.value, true);
			switchToModeSection(window.SDGui.flagCore.getMode());
			updateModeSections();
			renderBundleFields();
			syncAll();
		});
	}

	function bindCoreControls() {
		bindText("gen-prompt", "prompt");
		bindText("gen-negative", "negative_prompt");
		bindNumber("gen-width", "width");
		bindNumber("gen-height", "height");
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
	}

	function bindModeControls() {
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
		bindText("gen-video-init-img", "init_img");
		bindBrowse("btn-browse-video-init-img", () =>
			browsePath("init_img", "image", "Select start frame"),
		);
		bindText("gen-video-end-img", "end_img");
		bindBrowse("btn-browse-video-end-img", () =>
			browsePath("end_img", "image", "Select end frame"),
		);

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

		bindText("gen-convert-name", "convert_name");

		bindText("gen-metadata-image", "image");
		bindBrowse("btn-browse-metadata-image", () =>
			browsePath("image", "image", "Select image"),
		);
		bindEnum("gen-metadata-format", "metadata_format");
	}

	function bindButtons() {
		var genBtn = $("btn-generate");
		if (genBtn) genBtn.addEventListener("click", generate);
		var cancelBtn = $("btn-generate-cancel");
		if (cancelBtn) cancelBtn.addEventListener("click", cancel);
		var metadataBtn = $("btn-inspect-metadata");
		if (metadataBtn) metadataBtn.addEventListener("click", inspectMetadata);

		var seedBtn = $("btn-random-seed");
		if (seedBtn) {
			seedBtn.addEventListener("click", () => {
				var seed = Math.floor(Math.random() * 2147483647);
				window.SDGui.flagCore.setFlagValue("seed", seed);
				var seedInput = $("gen-seed");
				if (seedInput) seedInput.value = String(seed);
			});
		}
	}

	function bindKeyboardShortcuts() {
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
	}

	function bindStateSync() {
		window.SDGui.flagCore.onChange(() => {
			syncFromState(false);
		});
	}

	function renderInitialState() {
		renderBundleFields();
		hist.render();
		updateActionCopy();
		hist.attachToolbar();
	}

	function init() {
		initModules();
		moveWorkbenchTo(activeGenerateSection);

		var vals = ensurePreviewDefault();
		populateStaticSelects(vals);
		setupBundleSelect();
		bindCoreControls();
		bindModeControls();
		syncControlsFromState();
		updateModeSections();

		bindButtons();
		dims.init({ flagCore: window.SDGui.flagCore, onSyncAll: syncAll });
		bindKeyboardShortcuts();
		bindStateSync();
		renderInitialState();
		runner.resumeIfRunning();
	}

	return {
		init: init,
		renderBundleFields: renderBundleFields,
		generate: generate,
		cancel: cancel,
		renderHistory: hist.render,
		updateModeSections: updateModeSections,
		syncFromState: syncFromState,
		handleSectionChange: handleSectionChange,
	};
})();
