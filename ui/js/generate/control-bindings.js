// Control binding registry (Generate tab): binds DOM controls (text,
// number, enum, bool, slider+number compounds, path/file selects) to
// flagCore state and keeps them in sync. Owns the `controls` and
// `controlMirrors` registries so model-field pickers, mode inputs, and
// LoRA controls (Stage 4+) all register into one place.
//
// All reads/writes of state go through the injected `flagCore` (PLAN.md §8
// sync rule) — this module never mutates flag values directly. Safe DOM
// only (no innerHTML) per AGENTS.md frontend pitfall.
window.SDGui = window.SDGui || {};

window.SDGui.generateControls = (() => {
	var dom = window.SDGui.generateDom;
	var $ = dom.$;
	var el = dom.el;

	var flagCore = null;
	// populateModelSelect(select, purpose) is injected from the coordinator
	// (Stage 4 will move it into generateModelFields). Forward reference keeps
	// the registry decoupled from model-listing concerns and avoids a circular
	// dependency between this module and the future model-fields module.
	var populateModelSelect = () => Promise.resolve();

	// flagId -> { id, kind, select?, slider?, number?, valueLabel?, purpose? }
	var controls = {};
	// Secondary controls that share one flag with `controls` (e.g. init_img
	// appears in both the img2img and upscale panels). The primary entry in
	// `controls` is synced first, then each mirror id here. Owned here so any
	// module that registers a control can rely on a single mirror table.
	var controlMirrors = {}; // flagId -> [ids]

	// A setting may appear in more than one place (init_img lives in both the
	// img2img and upscale panels). Keep the first binding as the primary
	// control and register later ones as mirrors that read the same flagCore
	// state (UI State Sync Rule).
	function bindText(id, flagId) {
		var existing = controls[flagId];
		if (existing && existing.kind === "text" && existing.id !== id) {
			if (!controlMirrors[flagId]) controlMirrors[flagId] = [];
			if (!controlMirrors[flagId].includes(id)) controlMirrors[flagId].push(id);
		} else {
			controls[flagId] = { id: id, kind: "text" };
		}
		var node = $(id);
		if (node)
			node.addEventListener("input", () => {
				flagCore.setFlagValue(flagId, node.value);
			});
	}

	function bindNumber(id, flagId, isFloat) {
		controls[flagId] = { id: id, kind: isFloat ? "float" : "int" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				var v = isFloat ? parseFloat(node.value) : parseInt(node.value, 10);
				flagCore.setFlagValue(flagId, Number.isNaN(v) ? 0 : v);
			});
	}

	function bindEnum(id, flagId) {
		controls[flagId] = { id: id, kind: "enum" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				flagCore.setFlagValue(flagId, node.value);
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
			flagCore.setFlagValue(flagId, node.value);
		});
		populateModelSelect(node, purpose).then(() => syncControl(flagId));
	}

	function bindBool(id, flagId) {
		controls[flagId] = { id: id, kind: "bool" };
		var node = $(id);
		if (node)
			node.addEventListener("change", () => {
				flagCore.setFlagValue(flagId, node.checked);
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
			flagCore.setFlagValue(
				flagId,
				isFloat ? parseFloat(slider.value) : parseInt(slider.value, 10),
			);
		});
		number.addEventListener("change", () => {
			var n = isFloat ? parseFloat(number.value) : parseInt(number.value, 10);
			if (Number.isNaN(n)) n = 0;
			slider.value = String(n);
			flagCore.setFlagValue(flagId, n);
		});
		controls[flagId] = {
			id: id,
			kind: "slider",
			slider: slider,
			number: number,
		};
	}

	// Push the current flagCore value into a control (and its mirrors), unless
	// the user is actively editing that node. Stale/disconnected path selects
	// (left over after a bundle switch) are skipped — see Stage 3 pitfall in
	// the breakdown plan.
	function syncControl(flagId) {
		var entry = controls[flagId];
		if (!entry) return;
		var v = flagCore.getFlagValues()[flagId];
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

	// Coordinator-facing alias (kept so Stage 3 extraction doesn't churn the
	// many call sites that call syncAll() after a state mutation).
	function syncAll() {
		Object.keys(controls).forEach(syncControl);
	}

	// Inject flagCore + the model-select populator (forward reference for the
	// future Stage 4 model-fields module). Called from generateUi.init()
	// before any bind*() calls.
	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
		if (typeof options.populateModelSelect === "function") {
			populateModelSelect = options.populateModelSelect;
		}
	}

	return {
		init: init,
		// Registries exposed for modules that register controls directly
		// (model-field selects, LoRA controls). Shared by reference: they are
		// mutated in place and never reassigned.
		controls: controls,
		controlMirrors: controlMirrors,
		bindText: bindText,
		bindNumber: bindNumber,
		bindEnum: bindEnum,
		bindPathSelect: bindPathSelect,
		bindBool: bindBool,
		bindSliderNumber: bindSliderNumber,
		syncControl: syncControl,
		syncControlsFromState: syncControlsFromState,
		syncAll: syncAll,
	};
})();
