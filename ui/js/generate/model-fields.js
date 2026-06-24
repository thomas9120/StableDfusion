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
	var loraOptionsCache = null;
	var MAX_LORA_ROWS = 5;
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

	function appendMissingOption(select, value) {
		if (!select || !value) return;
		if (!Array.from(select.options).some((o) => o.value === value)) {
			select.appendChild(new Option(value, value));
		}
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

	async function fetchLoraOptions() {
		var data = await window.SDGui.fetchJson("/api/models?type=lora");
		loraOptionsCache = data.models || [];
		return loraOptionsCache;
	}

	async function populateLoraFileSelect(select) {
		try {
			await fetchLoraOptions();
			select.replaceChildren();
			select.appendChild(new Option("-- no active LoRA --", ""));
			loraOptionsCache.forEach((m) =>
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

	function normalizeLoraEntries(vals) {
		var entries = Array.isArray(vals.lora_files) ? vals.lora_files : [];
		entries = entries
			.map((entry) => ({
				path: String((entry && entry.path) || ""),
				strength:
					entry && entry.strength !== undefined && entry.strength !== ""
						? Number(entry.strength)
						: 1,
			}))
			.filter((entry) => entry.path);
		if (!entries.length && vals.lora_file) {
			entries.push({
				path: vals.lora_file,
				strength:
					vals.lora_strength !== undefined && vals.lora_strength !== ""
						? Number(vals.lora_strength)
						: 1,
			});
		}
		return entries.slice(0, MAX_LORA_ROWS);
	}

	function setLoraEntries(entries) {
		var clean = entries
			.slice(0, MAX_LORA_ROWS)
			.map((entry) => ({
				path: String((entry && entry.path) || ""),
				strength:
					entry && entry.strength !== undefined && entry.strength !== ""
						? Number(entry.strength)
						: 1,
			}))
			.filter((entry) => entry.path);
		var primary = clean[0] || { path: "", strength: 1 };
		flagCore.setMultipleFlagValues({
			lora_files: clean,
			lora_file: primary.path,
			lora_strength: primary.strength,
			lora_model_dir: primary.path ? fmt.loraFolderFromPath(primary.path) : "",
		});
	}

	function appendCachedLoraOptions(select) {
		select.replaceChildren();
		select.appendChild(new Option("-- select LoRA --", ""));
		(loraOptionsCache || []).forEach((m) =>
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
	}

	function refreshRenderedLoraSelects() {
		document
			.querySelectorAll("#gen-model-components .lora-row select")
			.forEach((select) => {
				var selected = select.value;
				appendCachedLoraOptions(select);
				appendMissingOption(select, selected);
				select.value = selected || "";
			});
	}

	async function refreshLoraOptions() {
		await fetchLoraOptions();
		refreshRenderedLoraSelects();
	}

	function renderLoraControls(container) {
		var wrap = el("div", "gen-model-field");
		var head = el("div", "field-head");
		head.appendChild(el("span", "form-label", "LoRAs"));
		wrap.appendChild(head);

		var list = el("div", "lora-list");
		wrap.appendChild(list);
		var pendingBlankRows = 0;

		function renderRows() {
			var vals = flagCore.getFlagValues();
			var activeEntries = normalizeLoraEntries(vals);
			var entries = activeEntries.slice();
			if (!entries.length || pendingBlankRows > 0) {
				var blanks = Math.max(1, pendingBlankRows);
				while (blanks > 0 && entries.length < MAX_LORA_ROWS) {
					entries.push({ path: "", strength: 1 });
					blanks -= 1;
				}
			}
			list.replaceChildren();
			entries.forEach((entry, index) => {
				var row = el("div", "field-row lora-row");
				var select = el("select");
				appendCachedLoraOptions(select);
				if (
					entry.path &&
					!Array.from(select.options).some((o) => o.value === entry.path)
				) {
					select.appendChild(new Option(entry.path, entry.path));
				}
				select.value = entry.path || "";
				select.addEventListener("change", () => {
					var next = normalizeLoraEntries(flagCore.getFlagValues());
					while (next.length <= index) next.push({ path: "", strength: 1 });
					next[index] = {
						path: select.value,
						strength: next[index].strength || 1,
					};
					if (select.value && pendingBlankRows > 0) pendingBlankRows -= 1;
					setLoraEntries(next);
					renderRows();
				});

				var slider = el("input");
				slider.type = "range";
				slider.min = "-1";
				slider.max = "2";
				slider.step = "0.05";
				slider.value = fmt.formatLoraStrength(entry.strength);
				var valueLabel = el(
					"span",
					"help-text lora-strength-value",
					fmt.formatLoraStrength(slider.value),
				);
				slider.addEventListener("input", () => {
					var value = Number(fmt.formatLoraStrength(slider.value));
					valueLabel.textContent = fmt.formatLoraStrength(value);
					var next = normalizeLoraEntries(flagCore.getFlagValues());
					while (next.length <= index) {
						next.push({ path: "", strength: 1 });
					}
					if (!next[index].path && !select.value) return;
					next[index] = { path: next[index].path || select.value, strength: value };
					setLoraEntries(next);
				});

				var remove = el("button", "btn btn-sm", "Remove");
				remove.type = "button";
				remove.disabled = entries.length === 1 && !entry.path;
				remove.addEventListener("click", () => {
					var next = normalizeLoraEntries(flagCore.getFlagValues());
					if (entry.path) {
						next.splice(index, 1);
						setLoraEntries(next);
					} else if (pendingBlankRows > 0) {
						pendingBlankRows -= 1;
					}
					renderRows();
				});

				row.appendChild(select);
				row.appendChild(slider);
				row.appendChild(valueLabel);
				row.appendChild(remove);
				list.appendChild(row);
			});

			var active = normalizeLoraEntries(flagCore.getFlagValues());
			var add = el("button", "btn btn-sm", "Add LoRA");
			add.type = "button";
			add.disabled =
				active.length === 0 ||
				active.length + pendingBlankRows >= MAX_LORA_ROWS;
			add.addEventListener("click", () => {
				var next = normalizeLoraEntries(flagCore.getFlagValues());
				if (next.length + pendingBlankRows < MAX_LORA_ROWS) {
					pendingBlankRows += 1;
					renderRows();
				}
			});
			list.appendChild(add);
		}

		var loading = el("div", "help-text", "Loading LoRAs...");
		list.appendChild(loading);
		var preload = el("select");
		populateLoraFileSelect(preload).then(renderRows);

		var hint = el(
			"p",
			"help-text",
			"Adds <lora:name:strength> tags to the prompt at generation time.",
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
					title: field.label || fieldLabel(field.key),
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
			var entry = controls[k];
			if (
				entry &&
				entry.kind === "path" &&
				entry.select &&
				entry.select.closest("#gen-model-components")
			) {
				delete controls[k];
			}
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
				label: f.label || fieldLabel(f.key),
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
				label: fieldLabel(key),
				required: false,
			}));
		}
		fieldList.forEach((field) => {
			var wrap = el("div", "gen-model-field");
			var head = el("div", "field-head");
			head.appendChild(el("span", "form-label", field.label));
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

	async function refreshModelLists() {
		var tasks = [];
		Object.keys(controls).forEach((key) => {
			var entry = controls[key];
			if (!entry || entry.kind !== "path" || !entry.select) return;
			if (!entry.select.isConnected) return;
			var selected =
				(flagCore && flagCore.getFlagValues
					? flagCore.getFlagValues()[key]
					: "") || entry.select.value;
			tasks.push(
				populateModelSelect(entry.select, entry.purpose).then(() => {
					appendMissingOption(entry.select, selected);
					entry.select.value = selected || "";
					syncControl(key);
					updateModelReadiness(key);
				}),
			);
		});
		tasks.push(refreshLoraOptions());
		await Promise.all(tasks);
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
		refreshModelLists: refreshModelLists,
	};
})();
