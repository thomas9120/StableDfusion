// Filtering helpers over flag definitions. Pure functions, no DOM.
window.SDGui = window.SDGui || {};

// Map of enum flag id -> ordered option list. Single place that binds flag ids
// to the canonical option lists defined in options.js (PLAN.md §9).
window.SDGui.ENUM_OPTIONS = {
	run_mode: () => window.SDGui.SD_MODES || [],
	metadata_format: () => ["text", "json"],
	sampling_method: () => window.SDGui.SAMPLING_METHODS || [],
	high_noise_sampling_method: () => window.SDGui.SAMPLING_METHODS || [],
	scheduler: () => window.SDGui.SCHEDULERS || [],
	type: () => window.SDGui.WEIGHT_TYPES || [],
	preview: () => window.SDGui.PREVIEW_METHODS || [],
	rng: () => window.SDGui.RNG_TYPES || [],
	sampler_rng: () => [""].concat(window.SDGui.RNG_TYPES || []),
	vae_format: () => window.SDGui.VAE_FORMATS || [],
	prediction: () => window.SDGui.PREDICTION_TYPES || [],
	lora_apply_mode: () => window.SDGui.LORA_APPLY_MODES || [],
	scm_policy: () => window.SDGui.SCM_POLICIES || [],
};

window.SDGui.flagMatchesMode = (flag, mode) => {
	if (!mode) return true;
	if (!flag) return false;
	if (flag.mode === "all") return true;
	if (Array.isArray(flag.mode)) return flag.mode.indexOf(mode) !== -1;
	return flag.mode === mode;
};

window.SDGui.getFlagsForMode = (mode) => {
	var flags = window.SDGui.SD_CLI_FLAGS || [];
	if (!mode) return flags.slice();
	return flags.filter((f) => window.SDGui.flagMatchesMode(f, mode));
};

window.SDGui.getFlagsByCategory = (categoryId, mode) =>
	window.SDGui.getFlagsForMode(mode).filter((f) => f.category === categoryId);

window.SDGui.getFlagById = (id) =>
	(window.SDGui.SD_CLI_FLAGS || []).find((f) => f.id === id) || null;

// Ordered option list for an enum flag, or null if the flag is not an enum.
// Resolution order: ENUM_OPTIONS central map → flag.options inline → null.
window.SDGui.optionsForFlag = (flag) => {
	if (!flag || flag.type !== "enum") return null;
	var resolver = window.SDGui.ENUM_OPTIONS[flag.id];
	if (resolver) return resolver();
	if (Array.isArray(flag.options) && flag.options.length) return flag.options.slice();
	return null;
};

window.SDGui.getBundleFields = (bundleValue) => {
	var bundles = window.SDGui.MODEL_TYPE_BUNDLES || [];
	var bundle = bundles.find((b) => b.value === bundleValue);
	return bundle ? bundle.fields : null;
};

window.SDGui.getBundle = (bundleValue) =>
	(window.SDGui.MODEL_TYPE_BUNDLES || []).find((b) => b.value === bundleValue) || null;
