// Filtering helpers over flag definitions. Pure functions, no DOM.
window.SDGui = window.SDGui || {};

window.SDGui.getFlagsForMode = (mode) => {
	var flags = window.SDGui.SD_CLI_FLAGS || [];
	if (!mode) return flags.slice();
	return flags.filter((f) => f.mode === "all" || f.mode === mode);
};

window.SDGui.getFlagsByCategory = (categoryId, mode) =>
	window.SDGui.getFlagsForMode(mode).filter((f) => f.category === categoryId);

window.SDGui.getBundleFields = (bundleValue) => {
	var bundles = window.SDGui.MODEL_TYPE_BUNDLES || [];
	var bundle = bundles.find((b) => b.value === bundleValue);
	return bundle ? bundle.fields : null;
};
