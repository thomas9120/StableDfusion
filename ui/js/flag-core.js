// Shared frontend flag state + launch-argument core.
// Mirrors LLama-GUI's flag-core.js. Owns the current mode, selected bundle,
// flagValues, shared setters, custom-args parsing, and getLaunchArgs().
//
// UI-state sync rule (PLAN.md §8): ALL changes route through setFlagValue();
// never mutate flagValues directly. Every control (Generate + Configure) reads
// from this same state, so dimensions/seed/etc. stay in sync across tabs.
window.SDGui = window.SDGui || {};

window.SDGui.flagCore = (() => {
	var state = {
		mode: "img_gen",
		bundle: "sd1",
		tool: "sd-cli",
		flagValues: {},
	};
	var listeners = [];

	function notify() {
		listeners.forEach((fn) => {
			try {
				fn(getSnapshot());
			} catch (e) {
				console.warn("flagCore listener error", e);
			}
		});
	}

	function defaultsFromFlags() {
		var vals = {};
		(window.SDGui.SD_CLI_FLAGS || []).forEach((f) => {
			vals[f.id] = f.default;
		});
		vals.custom_args = "";
		return vals;
	}

	function getSnapshot() {
		return {
			mode: state.mode,
			bundle: state.bundle,
			tool: state.tool,
			flagValues: state.flagValues,
		};
	}

	state.flagValues = defaultsFromFlags();

	// Apply a model-type bundle's suggested defaults (width/height/steps/cfg/...)
	// on top of the existing flag state. Missing keys are left untouched.
	function applyBundleDefaults(bundleValue) {
		var bundle = window.SDGui.getBundle(bundleValue);
		if (!bundle || !bundle.defaults) return;
		var merged = Object.assign({}, state.flagValues, bundle.defaults);
		state.flagValues = merged;
	}

	// Shell-like tokenizer for the custom-args string. Honors single/double
	// quotes and backslash escapes; bare tokens split on whitespace.
	function tokenizeCustomArgs(text) {
		var tokens = [];
		var cur = "";
		var i = 0;
		var quote = null;
		var hasChar = false;
		while (i < text.length) {
			var ch = text[i];
			if (quote) {
				if (ch === "\\") {
					var next = text[i + 1];
					if (next !== undefined) {
						cur += next;
						i += 2;
						hasChar = true;
						continue;
					}
				}
				if (ch === quote) {
					quote = null;
				} else {
					cur += ch;
					hasChar = true;
				}
				i += 1;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				hasChar = true;
				i += 1;
				continue;
			}
			if (ch === "\\") {
				var nxt = text[i + 1];
				if (nxt !== undefined) {
					cur += nxt;
					hasChar = true;
					i += 2;
					continue;
				}
			}
			if (/\s/.test(ch)) {
				if (hasChar) {
					tokens.push(cur);
					cur = "";
					hasChar = false;
				}
				i += 1;
				continue;
			}
			cur += ch;
			hasChar = true;
			i += 1;
		}
		if (hasChar) tokens.push(cur);
		return tokens;
	}

	function modeMatches(flag) {
		return flag.mode === "all" || flag.mode === state.mode;
	}

	// Build the sd-cli argv from shared state.
	//   1. iterate flags filtered by mode
	//   2. skip backendOwned args + inert defaults
	//   3. emit [flag, value] pairs (bools emit [flag] only)
	//   4. parse + append custom args
	// Returns { args, error, warnings }.
	function getLaunchArgs() {
		var args = [];
		var warnings = [];
		var vals = state.flagValues;
		var flags = window.SDGui.SD_CLI_FLAGS || [];

		flags.forEach((f) => {
			if (!modeMatches(f)) return;
			if (f.backendOwned) return;

			var v = vals[f.id];
			if (v === undefined || v === null) return;

			if (f.type === "bool") {
				if (v === true) args.push([f.flag]);
				return;
			}

			// Skip inert defaults (incl. empty strings).
			if (v === f.default) return;
			if (v === "") return;

			if (f.type === "int" || f.type === "float") {
				if (v === "" || Number.isNaN(Number(v))) {
					warnings.push("Invalid number for " + f.id + ": " + JSON.stringify(v));
					return;
				}
				args.push([f.flag, String(v)]);
			} else {
				args.push([f.flag, String(v)]);
			}
		});

		// Custom launch args (verbatim, appended last).
		var customRaw = vals.custom_args || "";
		if (customRaw.trim()) {
			tokenizeCustomArgs(customRaw).forEach((tok) => args.push([tok]));
		}

		// Required-input check: img_gen/vid_gen/convert need a model.
		var needsModel =
			state.mode === "img_gen" || state.mode === "vid_gen" || state.mode === "convert";
		if (needsModel) {
			if (!vals.model && !vals.diffusion_model) {
				return {
					args: args,
					error: "No model selected. Choose a model file (or diffusion-model) for this mode.",
					warnings: warnings,
				};
			}
		}

		return { args: args, error: null, warnings: warnings };
	}

	return {
		getSnapshot: getSnapshot,
		getMode: () => state.mode,
		setMode: (mode) => {
			state.mode = mode;
			notify();
		},
		getBundle: () => state.bundle,
		setBundle: (bundle, applyDefaults) => {
			state.bundle = bundle;
			if (applyDefaults) applyBundleDefaults(bundle);
			notify();
		},
		getTool: () => state.tool,
		getFlagValues: () => state.flagValues,
		setFlagValue: (id, value) => {
			state.flagValues[id] = value;
			notify();
		},
		setMultipleFlagValues: (vals) => {
			Object.assign(state.flagValues, vals || {});
			notify();
		},
		// Reset every flag back to its definition default (keeps mode/bundle).
		resetToDefaults: () => {
			state.flagValues = defaultsFromFlags();
			notify();
		},
		onChange: (fn) => {
			listeners.push(fn);
			return () => {
				var idx = listeners.indexOf(fn);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
		tokenizeCustomArgs: tokenizeCustomArgs,
		getLaunchArgs: getLaunchArgs,
	};
})();
