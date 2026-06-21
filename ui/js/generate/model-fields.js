// Bundle-driven model-component pickers and LoRA controls (Generate tab).
// Owns: fieldLabel, populateModelSelect, populateLoraFileSelect,
// renderLoraControls, browseModel, renderBundleFields.
//
// All state reads/writes flow through the injected `flagCore` (PLAN.md §8
// sync rule). The `controls` registry and `syncControl` helper are injected
// from window.SDGui.generateControls so the path-select entries created
// here register into the single shared table — and stale entries left over
// from a previous bundle are pruned in-place before each re-render.
//
// LoRA prompt-tag injection (`<lora:name:strength>` and
// `--lora-model-dir`) is the run-controller's job (Stage 7). It stays out
// of this module so the path-parsing helpers in
// window.SDGui.generateFormatters stay the single source of truth for
// LoRA-path → prompt-tag transformation.
//
// Safe DOM only (no innerHTML) per AGENTS.md frontend pitfall.
window.SDGui = window.SDGui || {};

window.SDGui.generateModelFields = (() => {
	var dom = window.SDGui.generateDom;
	var fmt = window.SDGui.generateFormatters;
	var $ = dom.$;
	var el = dom.el;

	var flagCore = null;
	// Shared registry from window.SDGui.generateControls. Injected by init()
	// so this module doesn't reach back into another module's closure.
	var controls = {};
	var readinessChips = {};
	// Re-sync a single control after its dropdown has been populated.
	var syncControl = function () {};
	// Called after a local state mutation so the coordinator can refresh
	// non-focused controls immediately (Configure tab, history mode badge,
	// etc.) instead of waiting for the flagCore.onChange cycle.
	var onSyncAll = function () {};

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

	function setModelReadiness(key, selected, required) {
		var chip = readinessChips[key];
		if (!chip) return;
		chip.className = "model-status-chip";
		if (selected) {
			chip.classList.add(required ? "is-ready" : "is-set");
			chip.textContent = required ? "ready" : "set";
			return;
		}
		if (required) {
			chip.classList.add("is-needed");
			chip.textContent = "needed";
		} else {
			chip.classList.add("is-optional");
			chip.textContent = "optional";
		}
	}

	function updateModelReadiness(key) {
		var entry = controls[key];
		var chip = readinessChips[key];
		if (!entry || !chip) return;
		var value = flagCore && flagCore.getFlagValues
			? flagCore.getFlagValues()[key]
			: "";
		setModelReadiness(
			key,
			!!value || !!(entry.select && entry.select.value),
			chip.required,
		);
	}

	function updateAllModelReadiness() {
		Object.keys(readinessChips).forEach(updateModelReadiness);
	}

	async function populateModelSelect(select, purpose) {
		try {
			var data = await window.SDGui.fetchJson(
				"/api/models?type=" + encodeURIComponent(purpose),
			);
			select.replaceChildren();
			select.appendChild(new Option("-- select from component folder --", ""));
			// sd-cli runs with cwd = project root, so prefix model-relative
			// paths so they resolve (Browse returns absolute paths which also
			// resolve).
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
			flagCore.setFlagValue("lora_file", select.value);
			if (select.value) {
				flagCore.setFlagValue(
					"lora_model_dir",
					fmt.loraFolderFromPath(select.value),
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
		var current = flagCore.getFlagValues().lora_strength;
		slider.value =
			current === undefined || current === "" ? "1" : String(current);
		var valueLabel = el(
			"span",
			"help-text",
			fmt.formatLoraStrength(slider.value),
		);
		controls.lora_strength = {
			id: null,
			kind: "range",
			slider: slider,
			valueLabel: valueLabel,
		};
		slider.addEventListener("input", () => {
			var value = fmt.formatLoraStrength(slider.value);
			valueLabel.textContent = value;
			flagCore.setFlagValue("lora_strength", Number(value));
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
				flagCore.setFlagValue(field.key, res.path);
				syncControl(field.key);
				updateModelReadiness(field.key);
			}
		} catch (e) {
			window.SDGui.toast(e.message, "error");
		}
	}

	function renderBundleFields() {
		var container = $("gen-model-components");
		if (!container) return;
		container.replaceChildren();

		// Drop stale model-picker controls from a previous bundle so
		// syncControl doesn't try to push values into detached <select>s.
		Object.keys(controls).forEach((k) => {
			if (controls[k] && controls[k].kind === "path") delete controls[k];
		});
		readinessChips = {};

		var bundleValue = flagCore.getBundle();
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
			var chip = el("span", "model-status-chip");
			chip.required = field.required;
			readinessChips[field.key] = chip;
			setModelReadiness(
				field.key,
				!!flagCore.getFlagValues()[field.key],
				field.required,
			);
			head.appendChild(chip);
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
				flagCore.setFlagValue(field.key, select.value);
				updateModelReadiness(field.key);
			});
			populateModelSelect(select, field.purpose).then(() => {
				syncControl(field.key);
				updateModelReadiness(field.key);
			});

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

	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
		// Default to the live shared registry / sync helper exposed by
		// window.SDGui.generateControls (Stage 3).
		controls =
			options.controls ||
			(window.SDGui.generateControls &&
				window.SDGui.generateControls.controls) ||
			controls;
		syncControl =
			options.syncControl ||
			(window.SDGui.generateControls &&
				window.SDGui.generateControls.syncControl) ||
			syncControl;
		onSyncAll = options.onSyncAll || function () {};
		if (flagCore && typeof flagCore.onChange === "function") {
			flagCore.onChange(updateAllModelReadiness);
		}
	}

	return {
		init: init,
		// Exposed so control-bindings.bindPathSelect (upscale_model dropdown)
		// can populate any path-kind select through the same model listing.
		populateModelSelect: populateModelSelect,
		// Exposed for the coordinator (bundle select change handler, init,
		// syncFromState) and for hf-download-ui.js which calls
		// window.SDGui.generateUi.renderBundleFields after a download.
		renderBundleFields: renderBundleFields,
	};
})();
