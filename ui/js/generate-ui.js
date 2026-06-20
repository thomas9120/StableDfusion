// PRIMARY Generate tab: prompt UI, bundle-driven model pickers, mode-specific
// inputs (img2img / upscale / convert / metadata), generate action, live
// preview polling, gallery + history. All state reads/writes go through
// window.SDGui.flagCore (PLAN.md §8 sync rule). Safe DOM only (no innerHTML).
window.SDGui = window.SDGui || {};

window.SDGui.generateUi = (() => {
	var pollTimer = null;
	var lastPreviewMtime = 0;
	var generating = false;
	var controls = {}; // flagId -> { id, kind }
	// Secondary controls that share one flag with `controls` (e.g. init_img
	// appears in both the img2img and upscale panels). The primary entry in
	// `controls` is synced first, then each mirror id here.
	var controlMirrors = {}; // flagId -> [ids]

	var HISTORY_KEY = "sdgui.generate.history";
	var HISTORY_STORE_CAP = 60; // max entries persisted to localStorage
	var HISTORY_VISIBLE_DEFAULT = 20; // max rendered before "show more"
	var historyExpanded = false; // whether the grid shows all entries
	var activeGenerateSection = "generate-image";
	var routingSection = false;

	// Stage 2: low-risk pure UI utilities live in dedicated modules under
	// ui/js/generate/. Alias the helpers we use heavily so the call sites
	// stay short. The dimension module is invoked by namespace since its
	// init/setup is wired up explicitly in init() below.
	var dom = window.SDGui.generateDom;
	var fmt = window.SDGui.generateFormatters;
	var dims = window.SDGui.generateDimensions;
	var $ = dom.$;
	var el = dom.el;
	var setHidden = dom.setHidden;
	var populateEnum = dom.populateEnum;
	var formatElapsed = fmt.formatElapsed;
	var relativeTime = fmt.relativeTime;
	var loraNameFromPath = fmt.loraNameFromPath;
	var loraFolderFromPath = fmt.loraFolderFromPath;
	var formatLoraStrength = fmt.formatLoraStrength;

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

	// A11 - run start time (epoch ms) for elapsed/ETA display.
	var runStartTime = 0;

	// ── Stage 1: internal dependency context ───────────────────────────
	// Centralizes the pieces future extracted helper modules (Stage 2+) will
	// receive explicitly, so they never reach back into these closure
	// variables. Mutable section state is exposed via *accessors* (never a
	// captured value) so a helper can never hold a stale activeGenerateSection
	// when the user switches between image/video/upscale/convert/metadata.
	// `controls` and `controlMirrors` are shared by reference: they are mutated
	// in place and never reassigned, so reference sharing stays correct.
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
	function bindText(id, flagId) {
		var existing = controls[flagId];
		if (existing && existing.kind === "text" && existing.id !== id) {
			// A setting may appear in more than one place (init_img lives in
			// both the img2img and upscale panels). Keep the first binding as
			// the primary control and register later ones as mirrors that read
			// the same flagCore state (UI State Sync Rule).
			if (!controlMirrors[flagId]) controlMirrors[flagId] = [];
			if (!controlMirrors[flagId].includes(id)) controlMirrors[flagId].push(id);
		} else {
			controls[flagId] = { id: id, kind: "text" };
		}
		var node = $(id);
		if (node)
			node.addEventListener("input", () => {
				window.SDGui.flagCore.setFlagValue(flagId, node.value);
			});
	}

	function bindNumber(id, flagId, isFloat) {
		controls[flagId] = { id: id, kind: isFloat ? "float" : "int" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				var v = isFloat ? parseFloat(node.value) : parseInt(node.value, 10);
				window.SDGui.flagCore.setFlagValue(flagId, Number.isNaN(v) ? 0 : v);
			});
	}

	function bindEnum(id, flagId) {
		controls[flagId] = { id: id, kind: "enum" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(flagId, node.value);
			});
	}

	function bindPathSelect(id, flagId, purpose) {
		var node = $(id);
		if (!node) return;
		controls[flagId] = {
			id: null,
			kind: "path",
			select: node,
			purpose: purpose,
		};
		node.addEventListener("change", () => {
			window.SDGui.flagCore.setFlagValue(flagId, node.value);
		});
		populateModelSelect(node, purpose).then(() => syncControl(flagId));
	}

	function bindBool(id, flagId) {
		controls[flagId] = { id: id, kind: "bool" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(flagId, node.checked);
			});
	}

	// A7 - enhance a bare number input into a slider + number compound, both
	// bound to flagCore. Keeps exact entry via the number field.
	function bindSliderNumber(id, flagId, min, max, step, isFloat) {
		var number = $(id);
		if (!number) return;
		var wrap = el("div", "slider-number");
		var slider = el("input");
		slider.type = "range";
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.setAttribute(
			"aria-label",
			number.getAttribute("aria-label") || flagId + " slider",
		);
		if (number.parentNode) number.parentNode.replaceChild(wrap, number);
		wrap.appendChild(slider);
		wrap.appendChild(number);
		var fmt = (v) =>
			isFloat
				? String(Math.round(Number(v) * 100) / 100)
				: String(parseInt(v, 10) || 0);
		slider.value = number.value;
		slider.addEventListener("input", () => {
			number.value = fmt(slider.value);
			window.SDGui.flagCore.setFlagValue(
				flagId,
				isFloat ? parseFloat(slider.value) : parseInt(slider.value, 10),
			);
		});
		number.addEventListener("change", () => {
			var n = isFloat ? parseFloat(number.value) : parseInt(number.value, 10);
			if (Number.isNaN(n)) n = 0;
			slider.value = String(n);
			window.SDGui.flagCore.setFlagValue(flagId, n);
		});
		controls[flagId] = {
			id: id,
			kind: "slider",
			slider: slider,
			number: number,
		};
	}

	function syncControl(flagId) {
		var entry = controls[flagId];
		if (!entry) return;
		var v = window.SDGui.flagCore.getFlagValues()[flagId];
		if (v === undefined || v === null) return;
		// Model-picker <select> (path kind).
		if (entry.kind === "path" && entry.select) {
			var sel = entry.select;
			if (!sel.isConnected) return; // stale (bundle switched) - skip
			if (v && !Array.from(sel.options).some((o) => o.value === v)) {
				sel.appendChild(new Option(v, v));
			}
			sel.value = v || "";
			return;
		}
		if (entry.kind === "range" && entry.slider) {
			if (!entry.slider.isConnected) return;
			entry.slider.value = String(v);
			if (entry.valueLabel) entry.valueLabel.textContent = String(v);
			return;
		}
		if (entry.kind === "slider" && entry.slider) {
			if (!entry.slider.isConnected) return;
			entry.slider.value = String(v);
			if (entry.number && document.activeElement !== entry.number)
				entry.number.value = String(v);
			return;
		}
		var applyToNode = (node) => {
			if (!node) return;
			// Don't clobber the control the user is currently editing.
			if (document.activeElement === node) return;
			if (entry.kind === "bool") node.checked = v === true;
			else node.value = String(v);
		};
		applyToNode($(entry.id));
		// Mirror controls share one flag (e.g. init_img in img2img + upscale).
		(controlMirrors[flagId] || []).forEach((mid) => {
			applyToNode($(mid));
		});
	}

	function syncControlsFromState() {
		Object.keys(controls).forEach(syncControl);
	}

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
	function fieldLabel(key) {
		var map = {
			model: "Model",
			diffusion_model: "Diffusion model",
			vae: "VAE",
			clip_l: "CLIP-L",
			clip_g: "CLIP-G",
			clip_vision: "CLIP vision",
			t5xxl: "T5XXL",
			llm: "LLM text encoder",
			llm_vision: "LLM vision",
			taesd: "TAESD",
			audio_vae: "Audio VAE",
			high_noise_diffusion_model: "High-noise diffusion model",
			uncond_diffusion_model: "Unconditional diffusion model",
			control_net: "ControlNet",
			embeddings_connectors: "Embeddings connectors",
			embd_dir: "Embeddings directory",
			lora_model_dir: "LoRA folder",
			photo_maker: "PhotoMaker",
			pulid_weights: "PuLID weights",
			upscale_model: "Upscale model",
			hires_upscalers_dir: "Hires upscalers folder",
		};
		return map[key] || key;
	}

	async function populateModelSelect(select, purpose) {
		try {
			var data = await window.SDGui.fetchJson(
				"/api/models?type=" + encodeURIComponent(purpose),
			);
			select.replaceChildren();
			select.appendChild(new Option("-- select from component folder --", ""));
			// sd-cli runs with cwd = project root, so prefix model-relative paths so
			// they resolve (Browse returns absolute paths which also resolve).
			(data.models || []).forEach((m) =>
				select.appendChild(
					new Option(
						(m.folder ? m.folder + "/" : "") +
							m.name +
							" (" +
							Math.round(m.size / 1048576) +
							" MB)",
						"models/" + m.relative,
					),
				),
			);
		} catch (e) {
			select.replaceChildren();
			select.appendChild(new Option("(could not list models)", ""));
		}
	}

	async function populateLoraFileSelect(select) {
		try {
			var data = await window.SDGui.fetchJson("/api/models?type=lora");
			select.replaceChildren();
			select.appendChild(new Option("-- no active LoRA --", ""));
			(data.models || []).forEach((m) =>
				select.appendChild(
					new Option(
						(m.folder ? m.folder + "/" : "") +
							m.name +
							" (" +
							Math.round(m.size / 1048576) +
							" MB)",
						"models/" + m.relative,
					),
				),
			);
		} catch (e) {
			select.replaceChildren();
			select.appendChild(new Option("(could not list LoRAs)", ""));
		}
	}

	function renderLoraControls(container) {
		var wrap = el("div", "gen-model-field");
		var head = el("div", "field-head");
		head.appendChild(el("span", "form-label", "Active LoRA"));
		wrap.appendChild(head);

		var row = el("div", "field-row");
		var select = el("select");
		select.appendChild(new Option("Loading...", ""));
		controls.lora_file = {
			id: null,
			kind: "path",
			select: select,
			purpose: "lora",
		};
		select.addEventListener("change", () => {
			window.SDGui.flagCore.setFlagValue("lora_file", select.value);
			if (select.value) {
				window.SDGui.flagCore.setFlagValue(
					"lora_model_dir",
					loraFolderFromPath(select.value),
				);
			}
		});
		populateLoraFileSelect(select).then(() => syncControl("lora_file"));
		row.appendChild(select);
		wrap.appendChild(row);

		var sliderRow = el("div", "field-row");
		var slider = el("input");
		slider.type = "range";
		slider.min = "-1";
		slider.max = "2";
		slider.step = "0.05";
		var current = window.SDGui.flagCore.getFlagValues().lora_strength;
		slider.value =
			current === undefined || current === "" ? "1" : String(current);
		var valueLabel = el("span", "help-text", formatLoraStrength(slider.value));
		controls.lora_strength = {
			id: null,
			kind: "range",
			slider: slider,
			valueLabel: valueLabel,
		};
		slider.addEventListener("input", () => {
			var value = formatLoraStrength(slider.value);
			valueLabel.textContent = value;
			window.SDGui.flagCore.setFlagValue("lora_strength", Number(value));
		});
		sliderRow.appendChild(slider);
		sliderRow.appendChild(valueLabel);
		wrap.appendChild(sliderRow);

		var hint = el(
			"p",
			"help-text",
			"Adds <lora:name:strength> to the prompt at generation time.",
		);
		wrap.appendChild(hint);
		container.appendChild(wrap);
	}

	async function browseModel(field) {
		try {
			var res = await window.SDGui.fetchJson("/api/select-file", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					purpose: field.purpose,
					title: fieldLabel(field.key),
				}),
			});
			if (res && res.selected && res.path) {
				window.SDGui.flagCore.setFlagValue(field.key, res.path);
				syncControl(field.key);
			}
		} catch (e) {
			window.SDGui.toast(e.message, "error");
		}
	}

	function renderBundleFields() {
		var container = $("gen-model-components");
		if (!container) return;
		container.replaceChildren();

		// Drop stale model-picker controls from a previous bundle.
		Object.keys(controls).forEach((k) => {
			if (controls[k] && controls[k].kind === "path") delete controls[k];
		});

		var bundleValue = window.SDGui.flagCore.getBundle();
		var bundle = window.SDGui.getBundle(bundleValue);
		var fields = bundle ? bundle.fields : null;

		var fieldList;
		if (fields && fields.length) {
			fieldList = fields.map((f) => ({
				key: f.key,
				purpose: f.purpose || f.key,
				required: !!f.required,
			}));
		} else {
			// Custom / empty bundle: show all model-component field pickers.
			fieldList = [
				"model",
				"diffusion_model",
				"high_noise_diffusion_model",
				"uncond_diffusion_model",
				"vae",
				"audio_vae",
				"clip_l",
				"clip_g",
				"clip_vision",
				"t5xxl",
				"llm",
				"llm_vision",
				"taesd",
				"control_net",
				"embeddings_connectors",
				"embd_dir",
				"photo_maker",
				"pulid_weights",
			].map((key) => ({
				key: key,
				purpose: (window.SDGui.BUNDLE_FIELD_PURPOSES || {})[key] || key,
				required: false,
			}));
		}
		fieldList.forEach((field) => {
			var wrap = el("div", "gen-model-field");
			var head = el("div", "field-head");
			head.appendChild(el("span", "form-label", fieldLabel(field.key)));
			if (field.required) head.appendChild(el("span", "req", "required"));
			wrap.appendChild(head);

			var row = el("div", "field-row");
			var select = el("select");
			select.appendChild(new Option("Loading...", ""));
			// Track this select for syncControl via a synthetic controls entry.
			controls[field.key] = {
				id: null,
				kind: "path",
				select: select,
				purpose: field.purpose,
			};
			select.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(field.key, select.value);
			});
			populateModelSelect(select, field.purpose).then(() =>
				syncControl(field.key),
			);

			var browse = el("button", "btn btn-sm", "Browse");
			browse.type = "button";
			browse.addEventListener("click", () => browseModel(field));

			row.appendChild(select);
			row.appendChild(browse);
			wrap.appendChild(row);
			container.appendChild(wrap);
		});
		renderLoraControls(container);
	}

	// path-kind control sync (model picker selects)
	function syncAll() {
		Object.keys(controls).forEach(syncControl);
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
	function loadHistory() {
		try {
			var raw = localStorage.getItem(HISTORY_KEY);
			var arr = raw ? JSON.parse(raw) : [];
			return Array.isArray(arr) ? arr : [];
		} catch (e) {
			return [];
		}
	}

	function saveHistory(entries) {
		try {
			localStorage.setItem(
				HISTORY_KEY,
				JSON.stringify(entries.slice(0, HISTORY_STORE_CAP)),
			);
		} catch (e) {
			/* quota - ignore */
		}
	}

	// Resolve the on-disk filename for a history entry. Newer entries store
	// `file` (always the real filename with extension); older ones only have
	// `name`, which may be a base_name without extension.
	function historyFileName(entry) {
		if (!entry) return "";
		return entry.file || entry.name || "";
	}

	function renderHistory() {
		var all = loadHistory();
		var total = all.length;
		var shown = historyExpanded
			? total
			: Math.min(total, HISTORY_VISIBLE_DEFAULT);
		var entries = all.slice(0, shown);

		// Header count badge.
		var countEl = $("gen-history-count");
		if (countEl) countEl.textContent = String(total);

		// Clear button is only meaningful when there's something to clear.
		var clearBtn = $("btn-clear-history");
		if (clearBtn) clearBtn.classList.toggle("hidden", total === 0);

		// "Show all" toggle: visible only when more exist than the default page.
		var moreBtn = $("btn-history-more");
		if (moreBtn) {
			var hidden = total <= HISTORY_VISIBLE_DEFAULT;
			moreBtn.classList.toggle("hidden", hidden);
			moreBtn.textContent = historyExpanded
				? "Show fewer"
				: "Show all " +
					total +
					" (" +
					(total - HISTORY_VISIBLE_DEFAULT) +
					" more)";
		}

		window.SDGui.gallery.renderHistoryGrid(
			$("gen-history"),
			entries,
			{
				onRestore: restoreFromHistory,
				onSend: (entry) => {
					sendToImg2img(historyFileName(entry));
				},
				onOpen: openHistoryImage,
				onDelete: removeHistoryEntry,
			},
			{ timeLabel: relativeTime },
		);
	}

	function restoreFromHistory(entry) {
		if (!entry || !entry.params) return;
		window.SDGui.flagCore.setMultipleFlagValues(entry.params);
		if (entry.bundle) window.SDGui.flagCore.setBundle(entry.bundle);
		if (entry.mode) window.SDGui.flagCore.setMode(entry.mode);
		if (entry.mode) switchToModeSection(entry.mode);
		syncFromState(true);
		window.SDGui.toast("Restored settings from history.", "info");
	}

	// View a history image at full size in the result frame.
	function openHistoryImage(entry) {
		var name = historyFileName(entry);
		if (!name) return;
		window.SDGui.gallery.renderResultImage(
			$("gen-result"),
			name,
			entry.prompt || "result",
			Date.now(),
		);
		var actions = $("gen-result-actions");
		var entryIsVideo = window.SDGui.gallery.isVideoFile(historyFileName(entry));
		if (actions) {
			actions.classList.remove("hidden");
			var openBtn = $("btn-open-result");
			var sendBtn = $("btn-send-img2img");
			var dlBtn = $("btn-download-result");
			if (openBtn) openBtn.onclick = () => openResultFile();
			if (sendBtn) {
				sendBtn.classList.toggle("hidden", entryIsVideo);
				if (!entryIsVideo) sendBtn.onclick = () => sendToImg2img(name);
			}
			if (dlBtn) dlBtn.onclick = () => downloadResult(name);
		}
		if (entry.prompt) {
			window.SDGui.toast("Viewing history image.", "info");
		}
	}

	// Remove a single entry by id (output file on disk is untouched).
	function removeHistoryEntry(entry) {
		if (!entry) return;
		var id = entry.id;
		var entries = loadHistory().filter((e) => e.id !== id);
		saveHistory(entries);
		renderHistory();
	}

	// Clear the whole list (output files on disk are untouched).
	async function clearHistory() {
		var ok = await window.SDGui.confirmAction(
			"Clear history?",
			"This removes all entries from the history list. The output image files on disk are not deleted.",
			"Clear history",
		);
		if (!ok) return;
		try {
			localStorage.removeItem(HISTORY_KEY);
		} catch (e) {
			/* ignore */
		}
		historyExpanded = false;
		renderHistory();
		window.SDGui.toast("History cleared.", "success");
	}

	// ── Generation flow ───────────────────────────────────────────────────
	function setGenerating(on) {
		generating = on;
		var genBtn = $("btn-generate");
		var cancelBtn = $("btn-generate-cancel");
		if (genBtn) genBtn.disabled = on;
		if (cancelBtn) cancelBtn.classList.toggle("hidden", !on);
	}

	function showProgressBar(visible, indeterminate) {
		var bar = $("gen-progress");
		if (!bar) return;
		bar.classList.toggle("hidden", !visible);
		bar.classList.toggle("indeterminate", !!indeterminate);
	}

	function setProgressFill(percent) {
		var fill = $("gen-progress-fill");
		if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
	}

	// vid_gen previews are multi-frame .webm files (sd-cli writes
	// .avi/.webm/.webp previews), so render them in a <video> instead of the
	// shared <img>. The <video> is created lazily inside the preview frame and
	// only used on the Generate Video tab; image modes keep using <img>.
	function ensurePreviewVideo() {
		var frame = $("gen-preview-frame");
		if (!frame) return null;
		var v = $("gen-preview-video");
		if (!v) {
			v = el("video", "preview-video");
			v.id = "gen-preview-video";
			v.controls = true;
			v.muted = true;
			v.playsInline = true;
			v.hidden = true;
			frame.insertBefore(v, $("gen-preview-empty") || null);
		}
		return v;
	}

	// Returns the active preview media element for the current mode, hiding the
	// inactive one so only one of <img>/<video> is visible at a time.
	function activePreviewMedia() {
		if (window.SDGui.flagCore.getMode() === "vid_gen") {
			var img = $("gen-preview");
			if (img) img.hidden = true;
			return ensurePreviewVideo();
		}
		var v = $("gen-preview-video");
		if (v) v.hidden = true;
		return $("gen-preview");
	}

	function resetPreview() {
		var img = $("gen-preview");
		if (img) {
			img.hidden = true;
			img.removeAttribute("src");
		}
		var v = $("gen-preview-video");
		if (v) {
			v.hidden = true;
			v.removeAttribute("src");
		}
		var previewEmpty = $("gen-preview-empty");
		if (previewEmpty) previewEmpty.style.display = "";
	}

	function refreshPreview(mtime) {
		var media = activePreviewMedia();
		var empty = $("gen-preview-empty");
		if (!media) return;
		media.src = "/api/generate/preview?t=" + mtime;
		media.hidden = false;
		// Live video preview: muted autoplay so the denoising preview animates.
		if (media.tagName === "VIDEO" && typeof media.play === "function") {
			media.play().catch(() => {});
		}
		if (empty) empty.style.display = "none";
	}

	function updateProgress(snap) {
		var text = $("gen-progress-text");
		var pct = $("gen-progress-pct");
		var running = snap.state === "running";
		showProgressBar(running || snap.state === "queued", !snap.total_steps);

		if (running && snap.total_steps) {
			setProgressFill(snap.percent || 0);
			// A11 - elapsed since run start (server started_at if present, else client).
			var started = snap.started_at ? snap.started_at * 1000 : runStartTime;
			var elapsed = started ? formatElapsed(Date.now() - started) : "";
			var eta = "";
			if (started && snap.percent > 0) {
				var ms = Date.now() - started;
				var etaMs = (ms / snap.percent) * (100 - snap.percent);
				eta = " · ETA " + formatElapsed(etaMs);
			}
			if (text)
				text.textContent =
					(snap.message || "Generating...") +
					"  " +
					snap.step +
					"/" +
					snap.total_steps +
					(elapsed ? "  ·  " + elapsed : "");
			if (pct) pct.textContent = (snap.percent || 0) + "%" + eta;
		} else if (running) {
			if (text) text.textContent = snap.message || "Starting...";
			if (pct) pct.textContent = "";
		} else {
			if (text) text.textContent = snap.message || snap.state;
			if (pct) pct.textContent = "";
		}
	}

	function showResultEmpty(message) {
		var box = $("gen-result");
		if (!box) return;
		box.replaceChildren();
		box.classList.remove("is-error");
		var cap = el(
			"div",
			"frame-empty",
			message || "Your generated image will appear here.",
		);
		cap.id = "gen-result-empty";
		box.appendChild(cap);
	}

	// A10 - copy-to-clipboard was REMOVED: the Web Clipboard API only
	// carries image *pixel data*, never a file reference, so pasting into a
	// folder (the obvious intent) is impossible by browser design — and
	// Download + Show-in-folder cover every file-management case. Do not
	// re-add without a different mechanism.

	function renderResult(snap) {
		var box = $("gen-result");
		var actions = $("gen-result-actions");
		if (!box) return;
		box.replaceChildren();
		box.classList.remove("is-error");

		// Show any generation warnings (small output, suspicious files, etc.).
		var wrn = snap.warnings || [];
		if (wrn.length) {
			var warnDiv = el("div", "gen-warnings");
			wrn.forEach((w) => {
				warnDiv.appendChild(el("div", "gen-warning-msg", "⚠ " + w));
			});
			box.appendChild(warnDiv);
		}

		// Show stderr tail (sd-cli diagnostics) when available.
		var stderrTail = (snap.stderr_tail || "").toString().trim();
		if (stderrTail) {
			var details = el("details", "gen-stderr");
			var summary = el("summary", "", "sd-cli diagnostic output (stderr)");
			details.appendChild(summary);
			var pre = el("pre", "gen-stderr-text");
			pre.textContent = stderrTail;
			details.appendChild(pre);
			box.appendChild(details);
		}

		var files = snap.result_files || [];
		var mode = snap.mode || window.SDGui.flagCore.getMode();

		// Metadata mode: no image file is produced - sd-cli prints the metadata
		// to stdout. Render the text into the result box.
		if (mode === "metadata") {
			var text = (snap.stdout_excerpt || "").toString();
			if (!text) {
				box.appendChild(
					el(
						"div",
						"help-text",
						"No metadata output captured (the image may have no embedded metadata).",
					),
				);
			} else {
				var pre = el("pre", "result-text");
				pre.textContent = text;
				box.appendChild(pre);
			}
			if (actions) actions.classList.add("hidden");
			addHistoryEntry(snap, files[0] || "metadata");
			return;
		}

		if (!files.length) {
			showResultEmpty("No image was produced.");
			if (actions) actions.classList.add("hidden");
			return;
		}
		// A2 - batch results: show a gallery when more than one file.
		if (files.length > 1) {
			window.SDGui.gallery.renderResultGallery(
				box,
				files,
				snap.prompt || "result",
				Date.now(),
			);
		} else {
			window.SDGui.gallery.renderResultImage(
				box,
				files[0],
				snap.prompt || "result",
				Date.now(),
			);
		}
		var first = files[0];
		var firstIsVideo = window.SDGui.gallery.isVideoFile(first);
		if (actions) {
			actions.classList.remove("hidden");
			var openBtn = $("btn-open-result");
			var sendBtn = $("btn-send-img2img");
			var dlBtn = $("btn-download-result");
			if (openBtn) openBtn.onclick = () => openResultFile();
			// "Send to img2img" only applies to images; hide it for video results.
			if (sendBtn) {
				sendBtn.classList.toggle("hidden", firstIsVideo);
				if (!firstIsVideo) sendBtn.onclick = () => sendToImg2img(first);
			}
			if (dlBtn) dlBtn.onclick = () => downloadResult(first);
		}
		// Add to history (one entry per result file for batch).
		files.forEach((f) => addHistoryEntry(snap, f));
	}

	// A9 - render an inline error in the result frame (instead of toast-only).
	function renderResultError(snap) {
		var box = $("gen-result");
		var actions = $("gen-result-actions");
		if (actions) actions.classList.add("hidden");
		if (!box) return;
		box.replaceChildren();
		box.classList.add("is-error");
		var msg = el(
			"div",
			"gen-error",
			"✗ " + (snap.error || "Generation failed."),
		);
		box.appendChild(msg);
		var stderrTail = (snap.stderr_tail || "").toString().trim();
		if (stderrTail) {
			var details = el("details", "gen-stderr");
			details.appendChild(
				el("summary", "", "sd-cli diagnostic output (stderr)"),
			);
			var pre = el("pre", "gen-stderr-text");
			pre.textContent = stderrTail;
			details.appendChild(pre);
			box.appendChild(details);
		}
	}

	function downloadResult(name) {
		if (!name) return;
		var a = el("a");
		a.href = "/api/image/" + encodeURIComponent(name) + "?download=1";
		a.download = String(name).split("/").pop() || "result";
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function openResultFile() {
		window.SDGui.fetchJson("/api/open-folder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder: "output" }),
		}).catch((e) => window.SDGui.toast(e.message, "error"));
	}

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

	function addHistoryEntry(snap, file) {
		var vals = window.SDGui.flagCore.getFlagValues();
		var ts = Date.now();
		var entry = {
			id: ts + "-" + Math.random().toString(36).slice(2, 8),
			name: snap.job_id || file,
			file: file, // real on-disk filename (with extension) — used by toolbar actions
			prompt: vals.prompt || "",
			thumb: "/api/image/" + encodeURIComponent(file) + "/thumbnail",
			timestamp: ts,
			bundle: window.SDGui.flagCore.getBundle(),
			mode: snap.mode || window.SDGui.flagCore.getMode(),
			params: vals,
		};
		var entries = loadHistory();
		entries.unshift(entry);
		saveHistory(entries);
		renderHistory();
	}

	async function poll() {
		try {
			var snap = await window.SDGui.fetchJson("/api/generate/status");
			updateProgress(snap);
			if (snap.state === "running") {
				if (snap.preview_mtime && snap.preview_mtime !== lastPreviewMtime) {
					lastPreviewMtime = snap.preview_mtime;
					refreshPreview(snap.preview_mtime);
				}
				return;
			}
			// Terminal state.
			stopPolling();
			setGenerating(false);
			if (snap.state === "done") {
				runStartTime = 0;
				showProgressBar(false);
				renderResult(snap);
				window.SDGui.toast("Generation complete.", "success");
			} else if (snap.state === "error") {
				runStartTime = 0;
				showProgressBar(false);
				renderResultError(snap);
				window.SDGui.toast(snap.error || "Generation failed.", "error");
			} else if (snap.state === "canceled") {
				runStartTime = 0;
				showProgressBar(false);
				window.SDGui.toast("Generation canceled.", "warning");
			}
		} catch (e) {
			/* transient network - keep polling */
		}
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function startPolling() {
		stopPolling();
		pollTimer = setInterval(poll, 400);
	}

	async function generate(options) {
		options = options || {};
		if (generating) return;
		var restoreMode = options.restoreMode || null;
		var result = window.SDGui.flagCore.getLaunchArgs();
		if (result.error) {
			window.SDGui.toast(result.error, "error");
			if (restoreMode) {
				window.SDGui.flagCore.setMode(restoreMode);
				syncFromState(false);
			}
			return;
		}
		(result.warnings || []).forEach((w) => window.SDGui.toast(w, "warning"));

		var vals = Object.assign({}, window.SDGui.flagCore.getFlagValues());
		if (vals.lora_file) {
			var loraName = loraNameFromPath(vals.lora_file);
			var loraStrength = formatLoraStrength(vals.lora_strength);
			var loraTag = "<lora:" + loraName + ":" + loraStrength + ">";
			vals.prompt = ((vals.prompt || "").trim() + " " + loraTag).trim();
			var promptPair = result.args.find(
				(pair) => pair[0] === "--prompt" || pair[0] === "-p",
			);
			if (promptPair) {
				promptPair[1] = vals.prompt;
			} else {
				result.args.push(["--prompt", vals.prompt]);
			}
			var loraDir = vals.lora_model_dir || loraFolderFromPath(vals.lora_file);
			vals.lora_model_dir = loraDir;
			if (!result.args.some((pair) => pair[0] === "--lora-model-dir")) {
				result.args.push(["--lora-model-dir", loraDir]);
			}
		}
		var body = {
			mode: window.SDGui.flagCore.getMode(),
			bundle: window.SDGui.flagCore.getBundle(),
			args: result.args,
			seed: vals.seed,
			total_steps: vals.steps,
			preview_method: vals.preview,
			preview_interval: vals.preview_interval,
			params: vals,
		};

		// Reset preview area (only relevant for img_gen/vid_gen, harmless for others).
		lastPreviewMtime = 0;
		resetPreview();
		// A9 — reset result frame to its empty state on a fresh run.
		showResultEmpty(activeConfig().running);
		setGenerating(true);
		runStartTime = Date.now();
		showProgressBar(true, true);
		var prog = $("gen-progress-text");
		if (prog) prog.textContent = "Starting…";

		try {
			await window.SDGui.fetchJson("/api/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (restoreMode) {
				window.SDGui.flagCore.setMode(restoreMode);
				syncFromState(false);
			}
			startPolling();
		} catch (e) {
			if (restoreMode) {
				window.SDGui.flagCore.setMode(restoreMode);
				syncFromState(false);
			}
			setGenerating(false);
			window.SDGui.toast(e.message, "error");
		}
	}

	function inspectMetadata() {
		var restoreMode = window.SDGui.flagCore.getMode();
		window.SDGui.flagCore.setMode("metadata");
		updateModeSections();
		generate({
			restoreMode: restoreMode === "metadata" ? "img_gen" : restoreMode,
		});
	}

	async function cancel() {
		try {
			await window.SDGui.fetchJson("/api/generate/cancel", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		} catch (e) {
			window.SDGui.toast(e.message, "error");
		}
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
		renderHistory();
		updateActionCopy();

		// History toolbar: clear-all (confirmed) + show-more toggle.
		var clearBtn = $("btn-clear-history");
		if (clearBtn) clearBtn.addEventListener("click", () => clearHistory());
		var moreBtn = $("btn-history-more");
		if (moreBtn)
			moreBtn.addEventListener("click", () => {
				historyExpanded = !historyExpanded;
				renderHistory();
			});

		// If a generation is already running (page reload), resume polling.
		window.SDGui.fetchJson("/api/generate/status")
			.then((snap) => {
				if (snap && snap.state === "running") {
					setGenerating(true);
					startPolling();
				}
			})
			.catch(() => {});
	}

	return {
		init: init,
		renderBundleFields: renderBundleFields,
		generate: generate,
		cancel: cancel,
		renderHistory: renderHistory,
		updateModeSections: updateModeSections,
		syncFromState: syncFromState,
		handleSectionChange: handleSectionChange,
	};
})();
