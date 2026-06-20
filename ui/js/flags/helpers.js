// Filtering helpers over flag definitions. Pure functions, no DOM.
window.SDGui = window.SDGui || {};

// Map of enum flag id -> ordered option list. Single place that binds flag ids
// to the canonical option lists defined in options.js (PLAN.md §9).
window.SDGui.ENUM_OPTIONS = {
	sampling_method: () => window.SDGui.SAMPLING_METHODS || [],
	scheduler: () => window.SDGui.SCHEDULERS || [],
	type: () => window.SDGui.WEIGHT_TYPES || [],
	preview: () => window.SDGui.PREVIEW_METHODS || [],
	rng: () => window.SDGui.RNG_TYPES || [],
};

window.SDGui.getFlagsForMode = (mode) => {
	var flags = window.SDGui.SD_CLI_FLAGS || [];
	if (!mode) return flags.slice();
	return flags.filter((f) => f.mode === "all" || f.mode === mode);
};

window.SDGui.getFlagsByCategory = (categoryId, mode) =>
	window.SDGui.getFlagsForMode(mode).filter((f) => f.category === categoryId);

window.SDGui.getFlagById = (id) =>
	(window.SDGui.SD_CLI_FLAGS || []).find((f) => f.id === id) || null;

// Ordered option list for an enum flag, or null if the flag is not an enum.
window.SDGui.optionsForFlag = (flag) => {
	if (!flag || flag.type !== "enum") return null;
	var resolver = window.SDGui.ENUM_OPTIONS[flag.id];
	return resolver ? resolver() : null;
};

window.SDGui.getBundleFields = (bundleValue) => {
	var bundles = window.SDGui.MODEL_TYPE_BUNDLES || [];
	var bundle = bundles.find((b) => b.value === bundleValue);
	return bundle ? bundle.fields : null;
};

window.SDGui.getBundle = (bundleValue) =>
	(window.SDGui.MODEL_TYPE_BUNDLES || []).find((b) => b.value === bundleValue) || null;
