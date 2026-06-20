// Configure tab rendering: search/filter, type-specific inputs, command preview.
// Reads/writes launch state through window.SDGui.flagCore only (PLAN.md §8 sync
// rule). All DOM is constructed safely (no innerHTML with dynamic content).
window.SDGui = window.SDGui || {};

window.SDGui.configFlagsUi = (() => {
	var searchQuery = "";
	var expandedCats = {};

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function makeInput(flag) {
		var vals = window.SDGui.flagCore.getFlagValues();
		var cur = vals[flag.id];
		var wrap = el("div", "flag-control");

		if (flag.type === "bool") {
			var cb = el("input");
			cb.type = "checkbox";
			cb.id = "cfg-" + flag.id;
			cb.checked = cur === true;
			cb.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(flag.id, cb.checked);
			});
			var lbl = el("label", "flag-control-label");
			lbl.setAttribute("for", cb.id);
			lbl.textContent = flag.label || flag.id;
			wrap.appendChild(cb);
			wrap.appendChild(lbl);
		} else if (flag.type === "enum") {
			var sel = el("select");
			sel.id = "cfg-" + flag.id;
			var opts = window.SDGui.optionsForFlag(flag) || [];
			opts.forEach((opt) => sel.appendChild(new Option(opt, opt)));
			if (cur !== undefined && cur !== null) sel.value = String(cur);
			sel.addEventListener("change", () => {
				window.SDGui.flagCore.setFlagValue(flag.id, sel.value);
			});
			wrap.appendChild(sel);
		} else {
			var input = el("input");
			input.id = "cfg-" + flag.id;
			if (flag.type === "int") {
				input.type = "number";
				input.step = "1";
			} else if (flag.type === "float") {
				input.type = "number";
				input.step = "any";
			} else {
				input.type = "text";
			}
			if (cur !== undefined && cur !== null) input.value = String(cur);
			input.addEventListener("change", () => {
				var val = input.value;
				if (flag.type === "int") val = parseInt(val, 10);
				else if (flag.type === "float") val = parseFloat(val);
				window.SDGui.flagCore.setFlagValue(flag.id, val);
			});
			wrap.appendChild(input);
		}
		return wrap;
	}

	function flagMatchesSearch(flag) {
		if (!searchQuery) return true;
		var q = searchQuery.toLowerCase();
		var hay = (
			(flag.id || "") +
			" " +
			(flag.flag || "") +
			" " +
			(flag.label || "") +
			" " +
			(flag.desc || "")
		).toLowerCase();
		return hay.indexOf(q) !== -1;
	}

	function renderCategory(cat) {
		var flags = window.SDGui.getFlagsByCategory(cat.id).filter(
			flagMatchesSearch,
		);
		if (!flags.length) return null;

		var panel = el("div", "cfg-category");
		var expanded = expandedCats[cat.id] !== false; // open by default
		var header = el("button", "cfg-cat-header" + (expanded ? " open" : ""));
		header.type = "button";
		header.textContent = (expanded ? "▾ " : "▸ ") + (cat.label || cat.id);
		header.addEventListener("click", () => {
			expandedCats[cat.id] = !expanded;
			render();
		});

		var body = el("div", "cfg-cat-body");
		if (!expanded) body.classList.add("hidden");
		flags.forEach((flag) => {
			var row = el("div", "cfg-flag-row");
			var meta = el("div", "cfg-flag-meta");
			meta.appendChild(el("div", "cfg-flag-name", flag.label || flag.id));
			meta.appendChild(el("div", "cfg-flag-desc", flag.desc || ""));
			var ctrl = makeInput(flag);
			row.appendChild(meta);
			row.appendChild(ctrl);
			body.appendChild(row);
		});

		panel.appendChild(header);
		panel.appendChild(body);
		return panel;
	}

	function renderCustomArgs() {
		var wrap = el("div", "cfg-custom");
		var lbl = el(
			"label",
			"form-label",
			"Custom launch args (appended verbatim)",
		);
		var ta = el("textarea");
		ta.id = "configure-custom-args";
		ta.rows = 2;
		ta.placeholder = '--my-flag value --another "quoted value"';
		ta.value = window.SDGui.flagCore.getFlagValues().custom_args || "";
		ta.addEventListener("input", () => {
			window.SDGui.flagCore.setFlagValue("custom_args", ta.value);
		});
		wrap.appendChild(lbl);
		wrap.appendChild(ta);
		return wrap;
	}

	function renderPreview() {
		var pre = document.getElementById("command-preview");
		if (!pre) return;
		var result = window.SDGui.flagCore.getLaunchArgs();
		var flat = ["sd-cli"];
		result.args.forEach((pair) => {
			flat.push(pair.join(" "));
		});
		var text = flat.join(" \\\n  ");
		if (result.error) text += "\n\n⚠ " + result.error;
		(result.warnings || []).forEach((w) => (text += "\n⚠ " + w));
		pre.textContent = text;
		// B1 — Copy button on the command preview.
		window.SDGui.attachCopyButton(pre, () => text);
	}

	function render() {
		var container = document.getElementById("configure-flags");
		if (!container) return;
		container.replaceChildren();
		(window.SDGui.FLAG_CATEGORIES || []).forEach((cat) => {
			var panel = renderCategory(cat);
			if (panel) container.appendChild(panel);
		});
		container.appendChild(renderCustomArgs());
		renderPreview();
	}

	function init() {
		var search = document.getElementById("flag-search");
		if (search) {
			search.addEventListener("input", () => {
				searchQuery = (search.value || "").trim();
				render();
			});
		}
		// Re-render when shared state changes (e.g. Generate edits the same flag).
		window.SDGui.flagCore.onChange(() => {
			// Avoid clobbering focused inputs: only refresh preview + visibility,
			// and rebuild only the non-focused controls via a light refresh.
			renderPreview();
		});
		// Full render whenever the user navigates to Configure (handled by app.js
		// tab switch indirectly via the periodic refresh); render once now.
		render();
	}

	return { init: init, render: render, renderPreview: renderPreview };
})();
