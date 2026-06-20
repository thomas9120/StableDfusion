// Read-only startup validation for flag definitions (PLAN.md §17).
// Detects duplicate ids, unknown types/categories, enum flags without an
// options resolver, and missing required schema fields. Pure, no DOM.
window.SDGui = window.SDGui || {};

window.SDGui.validateFlagDefinitions = () => {
	var warnings = [];
	var flags = window.SDGui.SD_CLI_FLAGS || [];
	var VALID_TYPES = ["bool", "int", "float", "text", "path", "enum"];
	var VALID_MODES = ["all", "img_gen", "vid_gen", "convert", "upscale", "metadata"];
	var seenIds = {};
	var seenFlags = {};

	var cats = (window.SDGui.FLAG_CATEGORIES || []).map((c) => c.id);
	var catSet = {};
	cats.forEach((c) => (catSet[c] = true));

	flags.forEach((f) => {
		if (!f.id) warnings.push("Flag missing id: " + JSON.stringify(f));
		if (seenIds[f.id]) warnings.push("Duplicate flag id: " + f.id);
		seenIds[f.id] = true;

		if (!f.flag) warnings.push("Flag " + f.id + " missing flag name");
		if (seenFlags[f.flag]) warnings.push("Duplicate flag name " + f.flag + " (id " + f.id + ")");
		seenFlags[f.flag] = true;

		if (VALID_TYPES.indexOf(f.type) === -1)
			warnings.push("Flag " + f.id + " has unknown type: " + f.type);
		var modes = Array.isArray(f.mode) ? f.mode : [f.mode];
		if (!modes.length || modes.some((m) => VALID_MODES.indexOf(m) === -1))
			warnings.push("Flag " + f.id + " has unknown mode: " + JSON.stringify(f.mode));
		if (f.category && !catSet[f.category])
			warnings.push("Flag " + f.id + " has unknown category: " + f.category);
		if (f.default === undefined) warnings.push("Flag " + f.id + " missing default");

		if (f.type === "enum") {
			var opts = window.SDGui.optionsForFlag(f);
			if (!opts || !opts.length)
				warnings.push("Enum flag " + f.id + " has no options resolver (ENUM_OPTIONS)");
			else if (opts.indexOf(f.default) === -1)
				warnings.push(
					"Enum flag " + f.id + " default '" + f.default + "' not in its options list",
				);
		}
	});

	return { ok: warnings.length === 0, warnings: warnings };
};
