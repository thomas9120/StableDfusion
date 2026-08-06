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
			var input = el(flag.type === "paths" ? "textarea" : "input");
			input.id = "cfg-" + flag.id;
			if (flag.type === "paths") {
				input.rows = 3;
				input.placeholder = "One path per line";
			} else if (flag.type === "int") {
				input.type = "number";
				input.step = "1";
			} else if (flag.type === "float") {
				input.type = "number";
				input.step = "any";
			} else {
				input.type = "text";
			}
			if (cur !== undefined && cur !== null)
				input.value =
					flag.type === "paths" && Array.isArray(cur)
						? cur.join("\n")
						: String(cur);
			var commit = () => {
				var val = input.value;
				if (flag.type === "paths")
					val = val
						.split(/\r?\n/)
						.map((path) => path.trim())
						.filter(Boolean);
				else if (flag.type === "int") val = parseInt(val, 10);
				else if (flag.type === "float") val = parseFloat(val);
				// M20 — don't persist NaN into shared state (empty/invalid
				// input). The flag keeps its previous value.
				if (Number.isNaN(val)) return;
				window.SDGui.flagCore.setFlagValue(flag.id, val);
			};
			// Single-line text fields commit live per keystroke (matches the
			// Generate tab's bindText and keeps the command preview live);
			// numeric + multi-path inputs commit on blur/Enter to avoid
			// intermediate-value flicker and mid-typing path mangling.
			input.addEventListener(input.type === "text" ? "input" : "change", commit);
			wrap.appendChild(input);
		}
		return wrap;
	}

	// Push the current shared value into a single rendered Configure control
	// (unless the user is editing it), mirroring generate/control-bindings'
	// syncControl. Used by the onChange refresh so external changes still
	// surface while another Configure input has focus — without rebuilding the
	// whole tab mid-typing (M19). `vals` is a single getFlagValues() snapshot
	// shared across the whole refresh (avoids one deep clone per flag).
	function syncInputFromState(flag, vals) {
		var node = document.getElementById("cfg-" + flag.id);
		if (!node || document.activeElement === node) return;
		var cur = vals[flag.id];
		if (cur === undefined || cur === null) return;
		if (flag.type === "bool") node.checked = cur === true;
		else if (flag.type === "paths")
			node.value = (Array.isArray(cur) ? cur : [cur]).filter(Boolean).join("\n");
		else node.value = String(cur);
	}

	// Same as syncInputFromState but for the custom-args textarea, which is
	// rendered separately (renderCustomArgs) and is not part of SD_CLI_FLAGS.
	function syncCustomArgs(vals) {
		var ta = document.getElementById("configure-custom-args");
		if (!ta || document.activeElement === ta) return;
		ta.value = vals.custom_args || "";
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
		var flags = window.SDGui
			.getFlagsByCategory(cat.id)
			.filter((f) => !f.backendOwned)
			.filter(flagMatchesSearch);
		if (!flags.length) return null;

		var panel = el("div", "cfg-category");
		var expanded = expandedCats[cat.id] === true;
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

	function expandAll() {
		(window.SDGui.FLAG_CATEGORIES || []).forEach((cat) => {
			expandedCats[cat.id] = true;
		});
		render();
	}

	function collapseAll() {
		(window.SDGui.FLAG_CATEGORIES || []).forEach((cat) => {
			expandedCats[cat.id] = false;
		});
		render();
	}

	function init() {
		var search = document.getElementById("flag-search");
		if (search) {
			search.addEventListener("input", () => {
				searchQuery = (search.value || "").trim();
				render();
			});
		}
		var btnExpand = document.getElementById("btn-expand-all");
		if (btnExpand) btnExpand.addEventListener("click", expandAll);
		var btnCollapse = document.getElementById("btn-collapse-all");
		if (btnCollapse) btnCollapse.addEventListener("click", collapseAll);
		// Re-render when shared state changes (e.g. Generate edits the same flag,
		// history restore, or bundle switch). M19 — while the user is editing a
		// Configure input, don't rebuild the whole tab (that would clobber the
		// focused field mid-typing); instead push state into every non-focused
		// control and refresh the preview so external changes still appear.
		window.SDGui.flagCore.onChange(() => {
			var container = document.getElementById("configure-flags");
			var focused = container && container.contains(document.activeElement);
			if (focused) {
				var vals = window.SDGui.flagCore.getFlagValues();
				(window.SDGui.SD_CLI_FLAGS || [])
					.filter((f) => !f.backendOwned)
					.forEach((f) => syncInputFromState(f, vals));
				syncCustomArgs(vals);
				renderPreview();
			} else {
				render();
			}
		});
		// Full render whenever the user navigates to Configure (handled by app.js
		// tab switch indirectly via the periodic refresh); render once now.
		render();
	}

	return { init: init, render: render, renderPreview: renderPreview };
})();
