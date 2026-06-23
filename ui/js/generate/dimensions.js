// Dimensions widget (Generate): "Aspect → Size" redesign.
// Owns: shape chips, size buttons, live readout, proportional preview
// swatch, exact W/H input snap-to-multiple, W/H swap.
// State flows through the injected `flagCore` so the Configure tab stays
// in sync; DOM updates only happen via `flagCore.setFlagValue` /
// `setMultipleFlagValues`. The injected `onSyncAll` is called after local
// state mutations so the coordinator can refresh non-focused controls
// (Configure, Generate bindings, history mode badge, etc.) immediately
// rather than waiting for the flagCore.onChange cycle.
window.SDGui = window.SDGui || {};

window.SDGui.generateDimensions = (() => {
	// A6 - dimension alignment multiple. SD needs mult of 8; many models 64.
	var DIM_MULTIPLE = 8;

	// Last shape the user engaged with, so the size row stays stable when
	// the current ratio is custom (no bucket highlight).
	var lastShape = "1:1";
	// M27 — track the shape the size buttons were last rendered for so we
	// only rebuild them when the shape actually changes (not on every
	// per-keystroke updateAffordances call).
	var renderedShape = null;

	var flagCore = null;
	var onSyncAll = function () {};

	// A6 - snap a value to the dimension multiple.
	function snapDim(v) {
		var n = parseInt(v, 10);
		if (Number.isNaN(n)) n = DIM_MULTIPLE;
		if (n < DIM_MULTIPLE) n = DIM_MULTIPLE;
		return Math.round(n / DIM_MULTIPLE) * DIM_MULTIPLE;
	}

	// Returns the canonical bucket {long,width,height} for the exact pixels,
	// or null when the size is custom (no preset matches).
	function findDimensionBucket(w, h) {
		var shape = window.SDGui.shapeFromRatio(w / h);
		var buckets = (window.SDGui.DIMENSION_BUCKETS || {})[shape] || [];
		return buckets.find((b) => b.width === w && b.height === h) || null;
	}

	function sizeTagForLong(long) {
		if (long <= 640) return "SD 1.x";
		if (long <= 800) return "SD 1.5";
		return "SDXL";
	}

	function budgetFor(mp) {
		if (mp <= 1.05) return { cls: "ok", text: "on budget" };
		if (mp <= 1.3) return { cls: "warn", text: "large" };
		return { cls: "over", text: "slow / OOM risk" };
	}

	// (Re)build the size buttons for the given shape, ascending longer edge,
	// plus a Custom escape hatch. Recommended = the SDXL-class bucket.
	function renderDimensionSizes(activeShape) {
		var wrap = document.getElementById("gen-dim-sizes");
		if (!wrap) return;
		wrap.replaceChildren();
		var buckets = (window.SDGui.DIMENSION_BUCKETS || {})[activeShape] || [];
		var recommended =
			buckets
				.filter((b) => b.long >= 1024)
				.sort((a, b) => a.long - b.long)[0] || buckets[buckets.length - 1];
		buckets.forEach((b) => {
			var btn = document.createElement("button");
			btn.className = "dim-size";
			btn.type = "button";
			btn.setAttribute("data-long", String(b.long));
			btn.setAttribute("data-w", String(b.width));
			btn.setAttribute("data-h", String(b.height));
			var num = document.createElement("span");
			num.className = "num";
			num.textContent = String(b.long);
			btn.appendChild(num);
			var tag = document.createElement("span");
			tag.className = "tag";
			tag.textContent = sizeTagForLong(b.long);
			btn.appendChild(tag);
			if (recommended && b.long === recommended.long)
				btn.classList.add("recommended");
			wrap.appendChild(btn);
		});
		var custom = document.createElement("button");
		custom.className = "dim-size";
		custom.type = "button";
		custom.setAttribute("data-long", "custom");
		var cNum = document.createElement("span");
		cNum.className = "num";
		cNum.textContent = "Custom";
		custom.appendChild(cNum);
		var cTag = document.createElement("span");
		cTag.className = "tag";
		cTag.textContent = "manual";
		custom.appendChild(cTag);
		wrap.appendChild(custom);
	}

	// Refresh shape/size highlights + the live readout from shared flag state.
	function updateAffordances() {
		if (!flagCore) return;
		var vals = flagCore.getFlagValues();
		var w = Number(vals.width) || 0;
		var h = Number(vals.height) || 0;
		var shape = window.SDGui.shapeFromRatio(h > 0 ? w / h : 0);
		if (shape) lastShape = shape;
		var bucket = findDimensionBucket(w, h);

		// Shape highlight (cleared if the ratio is custom).
		document.querySelectorAll("#gen-dim-shapes .dim-shape").forEach((chip) => {
			chip.classList.toggle(
				"active",
				!!shape && chip.getAttribute("data-shape") === shape,
			);
		});

		// Size buttons for the active shape, then highlight the matching bucket
		// — or Custom when the size is off-bucket. Only rebuild when the shape
		// actually changes (M27: avoid per-keystroke DOM rebuild).
		if (renderedShape !== lastShape) {
			renderDimensionSizes(lastShape);
			renderedShape = lastShape;
		}
		document.querySelectorAll("#gen-dim-sizes .dim-size").forEach((btn) => {
			var on = bucket
				? Number(btn.getAttribute("data-w")) === w &&
					Number(btn.getAttribute("data-h")) === h
				: btn.getAttribute("data-long") === "custom";
			btn.classList.toggle("active", on);
		});

		// Live readout.
		if (w && h) {
			var xy = document.getElementById("gen-dim-xy");
			if (xy) xy.textContent = w + " × " + h;
			var mp = document.getElementById("gen-dim-mp");
			if (mp) mp.textContent = ((w * h) / 1e6).toFixed(2) + " MP";
			var rLbl = document.getElementById("gen-dim-ratio");
			if (rLbl) rLbl.textContent = shape || "custom";
			var bLbl = document.getElementById("gen-dim-base");
			if (bLbl)
				bLbl.textContent = bucket ? bucket.long + " long edge" : "custom";
			var bud = document.getElementById("gen-dim-budget");
			if (bud) {
				var b = budgetFor((w * h) / 1e6);
				bud.className = "dim-budget " + b.cls;
				bud.textContent = b.text;
			}
			// Proportional preview swatch (long side capped at 80px).
			var box = document.getElementById("gen-dim-preview-box");
			if (box) {
				var scale = 80 / Math.max(w, h);
				box.style.width = Math.round(w * scale) + "px";
				box.style.height = Math.round(h * scale) + "px";
			}
		}
	}

	// Snap a single exact-dim input to the closest multiple of DIM_MULTIPLE
	// (and route the new value through flagCore so the Configure tab sees it).
	// Returns true when the input was changed.
	function snapInput(id) {
		var node = document.getElementById(id);
		if (!node) return false;
		var raw = node.value;
		var parsed = parseInt(raw, 10);
		var snapped = snapDim(raw);
		if (snapped === parsed) return false;
		node.value = String(snapped);
		if (flagCore) {
			flagCore.setFlagValue(id === "gen-width" ? "width" : "height", snapped);
		}
		return true;
	}

	// Public: snap both gen-width and gen-height inputs to the dimension
	// multiple. Returns true if either input was modified.
	function snapInputs() {
		var changed = snapInput("gen-width") || snapInput("gen-height");
		return changed;
	}

	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
		onSyncAll = options.onSyncAll || function () {};
		if (!flagCore) return;

		// A6 — dimension W/H swap + ratio chips + snap-to-multiple on blur.
		// Swap W/H (exact row); the shape/size highlights re-derive from ratio.
		var swapBtn = document.getElementById("btn-swap-dims");
		if (swapBtn) {
			swapBtn.addEventListener("click", () => {
				var vals = flagCore.getFlagValues();
				flagCore.setMultipleFlagValues({
					width: vals.height,
					height: vals.width,
				});
				onSyncAll();
				updateAffordances();
			});
		}

		// Shape chips: switch ratio, preserving the current longer edge by
		// snapping to the nearest quality-correct bucket for that shape.
		document.querySelectorAll("#gen-dim-shapes .dim-shape").forEach((chip) => {
			chip.addEventListener("click", () => {
				var shape = chip.getAttribute("data-shape");
				lastShape = shape;
				var vals = flagCore.getFlagValues();
				var longEdge = Math.max(
					Number(vals.width) || 1024,
					Number(vals.height) || 1024,
				);
				var buckets = (window.SDGui.DIMENSION_BUCKETS || {})[shape] || [];
				var best = null;
				var bestD = Infinity;
				buckets.forEach((b) => {
					var d = Math.abs(b.long - longEdge);
					if (d < bestD) {
						bestD = d;
						best = b;
					}
				});
				if (best) {
					flagCore.setMultipleFlagValues({
						width: best.width,
						height: best.height,
					});
					onSyncAll();
				}
				updateAffordances();
			});
		});

		// Size buttons (delegated — they're rebuilt on every render). A bucket
		// click sets the exact W/H; Custom opens the exact <details>.
		var sizesWrap = document.getElementById("gen-dim-sizes");
		if (sizesWrap) {
			sizesWrap.addEventListener("click", (ev) => {
				var btn = ev.target.closest(".dim-size");
				if (!btn) return;
				if (btn.getAttribute("data-long") === "custom") {
					var adv = document.getElementById("gen-dim-advanced");
					if (adv) adv.open = true;
					var wNode = document.getElementById("gen-width");
					if (wNode) wNode.focus();
					return;
				}
				flagCore.setMultipleFlagValues({
					width: Number(btn.getAttribute("data-w")),
					height: Number(btn.getAttribute("data-h")),
				});
				onSyncAll();
				updateAffordances();
			});
		}

		// Exact dimension inputs: snap to multiples of 8 on blur, and refresh
		// the shape/size highlights (Custom when off-bucket) on change.
		["gen-width", "gen-height"].forEach((id) => {
			var node = document.getElementById(id);
			if (node) {
				node.addEventListener("blur", () => {
					var prev = node.value;
					snapInput(id);
					if (node.value !== prev) onSyncAll();
					updateAffordances();
				});
				node.addEventListener("change", updateAffordances);
			}
		});
	}

	return {
		init: init,
		updateAffordances: updateAffordances,
		snapInputs: snapInputs,
	};
})();
