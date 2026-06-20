// Shared frontend flag state + launch-argument core.
// Mirrors LLama-GUI's flag-core.js. Owns the current mode, selected bundle,
// flagValues, shared setters, custom-args parsing, and getLaunchArgs().
//
// UI-state sync rule: ALL changes route through setFlagValue(); never mutate
// flagValues directly (PLAN.md §8).
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
				fn(state);
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
	state.flagValues = defaultsFromFlags();

	return {
		getMode: () => state.mode,
		setMode: (mode) => {
			state.mode = mode;
			notify();
		},
		getBundle: () => state.bundle,
		setBundle: (bundle) => {
			state.bundle = bundle;
			notify();
		},
		getFlagValues: () => state.flagValues,
		setFlagValue: (id, value) => {
			state.flagValues[id] = value;
			notify();
		},
		setMultipleFlagValues: (vals) => {
			Object.assign(state.flagValues, vals || {});
			notify();
		},
		onChange: (fn) => {
			listeners.push(fn);
		},
		// TODO(Phase 2): build [flag, value] pairs filtered by mode, skip inert
		// defaults, parse + append custom args, append model/diffusion path.
		// Return { args, error, warnings }.
		getLaunchArgs: () => ({ args: [], error: null, warnings: [] }),
	};
})();
