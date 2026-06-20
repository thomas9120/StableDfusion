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
	// A `mode` default switches the active mode (used by the wan bundle → vid_gen).
	function applyBundleDefaults(bundleValue) {
		var bundle = window.SDGui.getBundle(bundleValue);
		if (!bundle || !bundle.defaults) return;
		var incoming = Object.assign({}, bundle.defaults);
		if (typeof incoming.mode === "string" && incoming.mode) {
			state.mode = incoming.mode;
			state.flagValues.run_mode = incoming.mode;
			delete incoming.mode;
		}
		state.flagValues = Object.assign({}, state.flagValues, incoming);
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
		if (window.SDGui.flagMatchesMode) {
			return window.SDGui.flagMatchesMode(flag, state.mode);
		}
		return flag.mode === "all" || flag.mode === state.mode;
	}

	// Mode-specific required inputs (Phase 3). Different modes need different
	// file-pickers populated before sd-cli will run; surface that as a clear
	// error rather than letting sd-cli bail with an opaque message.
	function requiredInputError(vals) {
		switch (state.mode) {
			case "img_gen":
			case "vid_gen":
				if (!vals.model && !vals.diffusion_model) {
					return "No model selected. Choose a model (or diffusion-model) for this mode.";
				}
				return null;
			case "convert":
				if (!vals.model) {
					return "No source model selected. Convert mode needs a --model to read.";
				}
				return null;
			case "upscale":
				if (!vals.init_img) {
					return "No input image selected. Upscale mode needs an init image.";
				}
				if (!vals.upscale_model) {
					return "No ESRGAN upscale model selected. Choose an --upscale-model.";
				}
				return null;
			case "metadata":
				if (!vals.image) {
					return "No image selected. Metadata mode needs an image path.";
				}
				return null;
			default:
				return null;
		}
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

		// Mode-specific required-input check (Phase 3).
		var requiredError = requiredInputError(vals);
		if (requiredError) {
			return {
				args: args,
				error: requiredError,
				warnings: warnings,
			};
		}

		return { args: args, error: null, warnings: warnings };
	}

	return {
		getSnapshot: getSnapshot,
		getMode: () => state.mode,
		setMode: (mode) => {
			state.mode = mode;
			state.flagValues.run_mode = mode;
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
			state.flagValues.run_mode = state.mode;
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
