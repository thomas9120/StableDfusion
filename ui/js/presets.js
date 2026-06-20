// Preset CRUD + import/export. Presets are generation configs grouped by
// model type bundle. All state restores go through flagCore setters.
window.SDGui = window.SDGui || {};

window.SDGui.presets = (() => {
	var presets = [];
	var activeFilter = "all";

	function $(id) {
		return document.getElementById(id);
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function showStatus(type, message) {
		var box = $("presets-status");
		if (!box) return;
		box.className = "status-box " + (type || "");
		box.textContent = message || "";
		box.style.display = type ? "" : "none";
	}

	function bundleLabel(value) {
		var bundle = window.SDGui.getBundle ? window.SDGui.getBundle(value) : null;
		return bundle ? bundle.label : value || "Custom";
	}

	function cloneJson(value) {
		return JSON.parse(JSON.stringify(value || {}));
	}

	function currentPayload() {
		var name = ($("preset-name") && $("preset-name").value) || "";
		var description = ($("preset-description") && $("preset-description").value) || "";
		return {
			name: name.trim(),
			description: description.trim(),
			bundle: window.SDGui.flagCore.getBundle(),
			model_type: window.SDGui.flagCore.getBundle(),
			mode: window.SDGui.flagCore.getMode(),
			values: cloneJson(window.SDGui.flagCore.getFlagValues()),
		};
	}

	function populateFilter() {
		var filter = $("preset-filter");
		if (!filter) return;
		var current = filter.value || activeFilter;
		filter.replaceChildren();
		filter.appendChild(new Option("All model types", "all"));
		(window.SDGui.MODEL_TYPE_BUNDLES || []).forEach((b) => {
			filter.appendChild(new Option(b.label, b.value));
		});
		var unknown = {};
		presets.forEach((p) => {
			var bundle = p.bundle || p.model_type || "custom";
			if (!window.SDGui.getBundle(bundle)) unknown[bundle] = true;
		});
		Object.keys(unknown)
			.sort()
			.forEach((bundle) => filter.appendChild(new Option(bundleLabel(bundle), bundle)));
		filter.value = Array.from(filter.options).some((o) => o.value === current)
			? current
			: "all";
		activeFilter = filter.value;
	}

	function filteredPresets() {
		if (activeFilter === "all") return presets.slice();
		return presets.filter((p) => (p.bundle || p.model_type || "custom") === activeFilter);
	}

	function render() {
		populateFilter();
		var list = $("presets-list");
		if (!list) return;
		list.replaceChildren();

		var rows = filteredPresets();
		if (!rows.length) {
			list.appendChild(el("p", "help-text", "No presets saved."));
			return;
		}

		var groups = {};
		rows.forEach((preset) => {
			var bundle = preset.bundle || preset.model_type || "custom";
			if (!groups[bundle]) groups[bundle] = [];
			groups[bundle].push(preset);
		});

		Object.keys(groups)
			.sort((a, b) => bundleLabel(a).localeCompare(bundleLabel(b)))
			.forEach((bundle) => {
				var group = el("section", "preset-group");
				group.appendChild(el("h3", null, bundleLabel(bundle)));
				groups[bundle]
					.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
					.forEach((preset) => group.appendChild(renderRow(preset)));
				list.appendChild(group);
			});
	}

	function renderRow(preset) {
		var row = el("div", "preset-row");
		var meta = el("div", "preset-meta");
		meta.appendChild(el("div", "preset-title", preset.name || "Unnamed"));
		var pieces = [preset.mode || "img_gen"];
		if (preset.updated_at) pieces.push(new Date(preset.updated_at).toLocaleString());
		meta.appendChild(el("div", "preset-subtitle", pieces.join(" · ")));
		if (preset.description) {
			meta.appendChild(el("div", "preset-description", preset.description));
		}

		var actions = el("div", "preset-actions");
		var load = el("button", "btn btn-sm btn-primary", "Load");
		load.type = "button";
		load.addEventListener("click", () => applyPreset(preset));
		var exportBtn = el("button", "btn btn-sm", "Export");
		exportBtn.type = "button";
		exportBtn.addEventListener("click", () => exportPreset(preset));
		var del = el("button", "btn btn-sm btn-danger", "Delete");
		del.type = "button";
		del.addEventListener("click", () => deletePreset(preset));

		actions.appendChild(load);
		actions.appendChild(exportBtn);
		actions.appendChild(del);
		row.appendChild(meta);
		row.appendChild(actions);
		return row;
	}

	async function loadPresets() {
		try {
			var data = await window.SDGui.fetchJson("/api/presets");
			presets = Array.isArray(data.presets) ? data.presets : [];
			render();
		} catch (e) {
			showStatus("error", "Failed to load presets: " + e.message);
		}
	}

	async function saveCurrent() {
		var payload = currentPayload();
		if (!payload.name) {
			showStatus("error", "Preset name is required.");
			return;
		}
		try {
			var result = await window.SDGui.fetchJson("/api/presets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			showStatus("success", "Saved " + result.preset.name + ".");
			if ($("preset-name")) $("preset-name").value = "";
			if ($("preset-description")) $("preset-description").value = "";
			await loadPresets();
		} catch (e) {
			showStatus("error", "Save failed: " + e.message);
		}
	}

	function applyPreset(preset) {
		if (!preset) return;
		if (preset.bundle || preset.model_type) {
			window.SDGui.flagCore.setBundle(preset.bundle || preset.model_type, false);
		}
		if (preset.mode) window.SDGui.flagCore.setMode(preset.mode);
		window.SDGui.flagCore.setMultipleFlagValues(cloneJson(preset.values || preset.params || {}));
		if (window.SDGui.generateUi && window.SDGui.generateUi.syncFromState) {
			window.SDGui.generateUi.syncFromState(true);
		}
		if (window.SDGui.configFlagsUi && window.SDGui.configFlagsUi.render) {
			window.SDGui.configFlagsUi.render();
		}
		window.SDGui.toast("Loaded preset: " + (preset.name || "Unnamed"), "success");
	}

	async function deletePreset(preset) {
		if (!preset || !preset.name) return;
		var ok = await window.SDGui.confirmAction(
			"Delete Preset",
			"Delete preset " + preset.name + "?",
			"Delete",
		);
		if (!ok) return;
		try {
			await window.SDGui.fetchJson("/api/presets/" + encodeURIComponent(preset.name), {
				method: "DELETE",
			});
			showStatus("success", "Deleted " + preset.name + ".");
			await loadPresets();
		} catch (e) {
			showStatus("error", "Delete failed: " + e.message);
		}
	}

	function downloadJson(filename, payload) {
		var blob = new Blob([JSON.stringify(payload, null, 2)], {
			type: "application/json",
		});
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 500);
	}

	async function exportPreset(preset) {
		if (!preset || !preset.name) return;
		try {
			var data = await window.SDGui.fetchJson("/api/presets/shortcut", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: preset.name }),
			});
			downloadJson(data.filename || preset.name + ".json", data.preset || preset);
		} catch (e) {
			showStatus("error", "Export failed: " + e.message);
		}
	}

	function exportAll() {
		downloadJson("stable-d-gui-presets.json", {
			schema: 1,
			kind: "stable-d-gui.preset-bundle",
			exported_at: new Date().toISOString(),
			presets: presets,
		});
	}

	function importedPresets(payload) {
		if (Array.isArray(payload)) return payload;
		if (payload && Array.isArray(payload.presets)) return payload.presets;
		if (payload && payload.preset) return [payload.preset];
		if (payload && typeof payload === "object") return [payload];
		return [];
	}

	async function importFile(file) {
		if (!file) return;
		try {
			var text = await file.text();
			var payload = JSON.parse(text);
			var rows = importedPresets(payload);
			if (!rows.length) {
				showStatus("error", "No presets found in import file.");
				return;
			}
			var saved = 0;
			for (var i = 0; i < rows.length; i++) {
				await window.SDGui.fetchJson("/api/presets", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(rows[i]),
				});
				saved += 1;
			}
			showStatus("success", "Imported " + saved + " preset(s).");
			await loadPresets();
		} catch (e) {
			showStatus("error", "Import failed: " + e.message);
		}
	}

	function init() {
		var save = $("btn-save-preset");
		if (save) save.addEventListener("click", saveCurrent);

		var filter = $("preset-filter");
		if (filter) {
			filter.addEventListener("change", () => {
				activeFilter = filter.value || "all";
				render();
			});
		}

		var importButton = $("btn-import-presets");
		var importInput = $("preset-import-file");
		if (importButton && importInput) {
			importButton.addEventListener("click", () => importInput.click());
			importInput.addEventListener("change", () => {
				importFile(importInput.files && importInput.files[0]);
				importInput.value = "";
			});
		}

		var exportButton = $("btn-export-presets");
		if (exportButton) exportButton.addEventListener("click", exportAll);

		populateFilter();
		loadPresets();
	}

	return {
		init: init,
		load: loadPresets,
		render: render,
		applyPreset: applyPreset,
	};
})();
