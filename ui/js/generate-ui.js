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

	var HISTORY_KEY = "sdgui.generate.history";

	// Mode → mode-inputs container id (which sub-section is visible). Each
	// mode-inputs container holds the file pickers + numeric controls specific
	// to that mode (Phase 3: img2img, upscale, convert, metadata).
	var MODE_INPUT_PANELS = {
		img_gen: "gen-img2img-inputs",
		vid_gen: "gen-img2img-inputs", // vid_gen reuses img2img layout (init-img/end-img)
		upscale: "gen-upscale-inputs",
		convert: "gen-convert-inputs",
		metadata: "gen-metadata-inputs",
	};

	function $(id) {
		return document.getElementById(id);
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	// ── Control binding ────────────────────────────────────────────────────
	function bindText(id, flagId) {
		controls[flagId] = { id: id, kind: "text" };
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

	function bindBool(id, flagId) {
		controls[flagId] = { id: id, kind: "bool" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(flagId, node.checked);
			});
	}

	function populateEnum(id, options, current) {
		var node = $(id);
		if (!node) return;
		node.replaceChildren();
		options.forEach((opt) => node.appendChild(new Option(opt, opt)));
		if (current !== undefined && current !== null) node.value = String(current);
	}

	function syncControl(flagId) {
		var entry = controls[flagId];
		if (!entry) return;
		var v = window.SDGui.flagCore.getFlagValues()[flagId];
		if (v === undefined || v === null) return;
		// Model-picker <select> (path kind).
		if (entry.kind === "path" && entry.select) {
			var sel = entry.select;
			if (!sel.isConnected) return; // stale (bundle switched) — skip
			if (v && !Array.from(sel.options).some((o) => o.value === v)) {
				sel.appendChild(new Option(v, v));
			}
			sel.value = v || "";
			return;
		}
		var node = $(entry.id);
		if (!node) return;
		// Don't clobber the control the user is currently editing.
		if (document.activeElement === node) return;
		if (entry.kind === "bool") node.checked = v === true;
		else node.value = String(v);
	}

	function syncControlsFromState() {
		Object.keys(controls).forEach(syncControl);
	}

	// ── Mode-aware section visibility (Phase 3) ────────────────────────────
	function setHidden(node, hidden) {
		if (node) node.classList.toggle("hidden", !!hidden);
	}

	function updateModeSections() {
		var mode = window.SDGui.flagCore.getMode();
		var activePanelId = MODE_INPUT_PANELS[mode];

		// Toggle which mode-inputs panel is visible.
		Object.keys(MODE_INPUT_PANELS).forEach(function (m) {
			setHidden($(MODE_INPUT_PANELS[m]), MODE_INPUT_PANELS[m] !== activePanelId);
		});

		// Prompt + negative prompt + dimensions/steps/seed are only relevant
		// for img_gen / vid_gen (and not for upscale/convert/metadata).
		var usePrompt = mode === "img_gen" || mode === "vid_gen";
		setHidden($("gen-prompt-section"), !usePrompt);
		setHidden($("gen-sampling-section"), !usePrompt);
		setHidden($("gen-advanced-section"), !usePrompt);
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
			photo_maker: "PhotoMaker",
			pulid_weights: "PuLID weights",
		};
		return map[key] || key;
	}

	async function populateModelSelect(select, purpose) {
		try {
			var data = await window.SDGui.fetchJson("/api/models?type=" + encodeURIComponent(purpose));
			select.replaceChildren();
			select.appendChild(new Option("— select from component folder —", ""));
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

	async function browseModel(field) {
		try {
			var res = await window.SDGui.fetchJson("/api/select-file", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ purpose: field.purpose, title: fieldLabel(field.key) }),
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
			select.appendChild(new Option("Loading…", ""));
			// Track this select for syncControl via a synthetic controls entry.
			controls[field.key] = { id: null, kind: "path", select: select, purpose: field.purpose };
			select.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(field.key, select.value);
			});
			populateModelSelect(select, field.purpose).then(() => syncControl(field.key));

			var browse = el("button", "btn btn-sm", "Browse");
			browse.type = "button";
			browse.addEventListener("click", () => browseModel(field));

			row.appendChild(select);
			row.appendChild(browse);
			wrap.appendChild(row);
			container.appendChild(wrap);
		});
	}

	// path-kind control sync (model picker selects)
	function syncAll() {
		Object.keys(controls).forEach(syncControl);
	}

	function syncSelectorsFromState() {
		var modeSelect = $("gen-mode");
		if (modeSelect) modeSelect.value = window.SDGui.flagCore.getMode();
		var bundleSelect = $("gen-model-bundle");
		if (bundleSelect) bundleSelect.value = window.SDGui.flagCore.getBundle();
	}

	function syncFromState(renderFields) {
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
			localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 60)));
		} catch (e) {
			/* quota — ignore */
		}
	}

	function renderHistory() {
		window.SDGui.gallery.renderHistoryGrid($("gen-history"), loadHistory(), restoreFromHistory);
	}

	function restoreFromHistory(entry) {
		if (!entry || !entry.params) return;
		window.SDGui.flagCore.setMultipleFlagValues(entry.params);
		if (entry.bundle) window.SDGui.flagCore.setBundle(entry.bundle);
		if (entry.mode) window.SDGui.flagCore.setMode(entry.mode);
		syncFromState(true);
		window.SDGui.toast("Restored settings from history.", "info");
	}

	// ── Generation flow ───────────────────────────────────────────────────
	function setGenerating(on) {
		generating = on;
		var genBtn = $("btn-generate");
		var cancelBtn = $("btn-generate-cancel");
		if (genBtn) genBtn.disabled = on;
		if (cancelBtn) cancelBtn.classList.toggle("hidden", !on);
	}

	function refreshPreview(mtime) {
		var img = $("gen-preview");
		if (!img) return;
		img.src = "/api/generate/preview?t=" + mtime;
		img.hidden = false;
	}

	function updateProgress(snap) {
		var text = $("gen-progress-text");
		if (text) {
			if (snap.state === "running") {
				text.textContent =
					(snap.message || "Generating…") +
					(snap.total_steps ? "  (" + snap.percent + "%)" : "");
			} else {
				text.textContent = snap.message || snap.state;
			}
		}
	}

	function renderResult(snap) {
		var box = $("gen-result");
		var actions = $("gen-result-actions");
		if (!box) return;
		box.replaceChildren();

		// Show any generation warnings (small output, suspicious files, etc.).
		var wrn = snap.warnings || [];
		if (wrn.length) {
			var warnDiv = el("div", "gen-warnings");
			wrn.forEach(function (w) {
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

		// Metadata mode: no image file is produced — sd-cli prints the metadata
		// to stdout. The backend captures the tail into the sidecar (and may
		// expose it via the status payload). Render the text into the result box.
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
			if (actions) actions.classList.add("hidden");
			return;
		}
		var first = files[0];
		window.SDGui.gallery.renderResultImage(box, first, snap.prompt || "result", Date.now());
		if (actions) {
			actions.classList.remove("hidden");
			var openBtn = $("btn-open-result");
			var sendBtn = $("btn-send-img2img");
			if (openBtn) openBtn.onclick = () => openResultFile();
			if (sendBtn) sendBtn.onclick = () => sendToImg2img(first);
		}
		// Add to history.
		addHistoryEntry(snap, first);
	}

	function openResultFile() {
		window.SDGui
			.fetchJson("/api/open-folder", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ folder: "output" }),
			})
			.catch((e) => window.SDGui.toast(e.message, "error"));
	}

	function sendToImg2img(name) {
		window.SDGui.flagCore.setFlagValue("init_img", name);
		// Switch to img_gen if not already (img2img is an img_gen-only feature).
		if (window.SDGui.flagCore.getMode() !== "img_gen") {
			window.SDGui.flagCore.setMode("img_gen");
		}
		updateModeSections();
		syncAll();
		window.SDGui.toast("Set as init image. Adjust strength then Generate.", "info");
	}

	function addHistoryEntry(snap, file) {
		var vals = window.SDGui.flagCore.getFlagValues();
		var entry = {
			name: snap.job_id || file,
			prompt: vals.prompt || "",
			thumb: "/api/image/" + encodeURIComponent(file),
			timestamp: Date.now(),
			bundle: window.SDGui.flagCore.getBundle(),
			mode: window.SDGui.flagCore.getMode(),
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
				renderResult(snap);
				window.SDGui.toast("Generation complete.", "success");
			} else if (snap.state === "error") {
				window.SDGui.toast(snap.error || "Generation failed.", "error");
			} else if (snap.state === "canceled") {
				window.SDGui.toast("Generation canceled.", "warning");
			}
		} catch (e) {
			/* transient network — keep polling */
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

	async function generate() {
		if (generating) return;
		var result = window.SDGui.flagCore.getLaunchArgs();
		if (result.error) {
			window.SDGui.toast(result.error, "error");
			return;
		}
		(result.warnings || []).forEach((w) => window.SDGui.toast(w, "warning"));

		var vals = window.SDGui.flagCore.getFlagValues();
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
		var img = $("gen-preview");
		if (img) {
			img.hidden = true;
			img.removeAttribute("src");
		}
		setGenerating(true);
		var prog = $("gen-progress-text");
		if (prog) prog.textContent = "Starting…";

		try {
			await window.SDGui.fetchJson("/api/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			startPolling();
		} catch (e) {
			setGenerating(false);
			window.SDGui.toast(e.message, "error");
		}
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

	function init() {
		// Generate defaults: enable live preview (sd-cli defaults to none).
		var vals = window.SDGui.flagCore.getFlagValues();
		if (!vals.preview || vals.preview === "none") {
			window.SDGui.flagCore.setFlagValue("preview", window.SDGui.DEFAULT_PREVIEW_METHOD || "vae");
		}

		// Populate enum selects from the canonical option lists.
		populateEnum("gen-sampler", window.SDGui.SAMPLING_METHODS, vals.sampling_method);
		populateEnum("gen-scheduler", window.SDGui.SCHEDULERS, vals.scheduler);
		populateEnum("gen-type", window.SDGui.WEIGHT_TYPES, vals.type);
		populateEnum("gen-preview-method", window.SDGui.PREVIEW_METHODS, vals.preview);

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
				// applyBundleDefaults may switch the mode (e.g. wan → vid_gen);
				// reflect that in the mode dropdown + mode-specific UI.
				var modeSelect = $("gen-mode");
				if (modeSelect) modeSelect.value = window.SDGui.flagCore.getMode();
				updateModeSections();
				renderBundleFields();
				syncAll();
			});
		}

		// Mode dropdown.
		var modeSelect = $("gen-mode");
		if (modeSelect) {
			modeSelect.value = window.SDGui.flagCore.getMode();
			modeSelect.addEventListener("change", () => {
				window.SDGui.flagCore.setMode(modeSelect.value);
				updateModeSections();
			});
		}

		// Bind core controls.
		bindText("gen-prompt", "prompt");
		bindText("gen-negative", "negative_prompt");
		bindNumber("gen-width", "width");
		bindNumber("gen-height", "height");
		bindNumber("gen-steps", "steps");
		bindNumber("gen-cfg", "cfg_scale", true);
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
		bindBrowse("btn-browse-init-img", () => browsePath("init_img", "image", "Select init image"));
		bindNumber("gen-strength", "strength", true);
		bindNumber("gen-control-strength", "control_strength", true);
		bindText("gen-mask", "mask");
		bindBrowse("btn-browse-mask", () => browsePath("mask", "image", "Select mask image"));
		bindText("gen-control-image", "control_image");
		bindBrowse("btn-browse-control-image", () =>
			browsePath("control_image", "image", "Select control image"),
		);

		// Upscale mode inputs (init_img shares state with img2img init_img).
		bindText("gen-upscale-init-img", "init_img");
		bindBrowse("btn-browse-upscale-init-img", () =>
			browsePath("init_img", "image", "Select init image"),
		);
		bindText("gen-upscale-model", "upscale_model");
		bindBrowse("btn-browse-upscale-model", () =>
			browsePath("upscale_model", "esrgan", "Select ESRGAN upscale model"),
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

		// Cross-tab / cross-control sync: refresh non-focused controls on change.
		window.SDGui.flagCore.onChange(() => {
			syncFromState(false);
		});

		renderBundleFields();
		renderHistory();

		// If a generation is already running (page reload), resume polling.
		window.SDGui
			.fetchJson("/api/generate/status")
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
	};
})();
