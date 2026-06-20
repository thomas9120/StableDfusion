// Shared data: quick generation profiles + model-type list.
window.SDGui = window.SDGui || {};

window.SDGui.QUICK_PROFILES = [
	{
		value: "sd15-default",
		label: "SD 1.5 Default",
		bundle: "sd1",
		flagValues: { width: 512, height: 512, steps: 20, cfg_scale: 7.0 },
	},
	{
		value: "sdxl",
		label: "SDXL",
		bundle: "sdxl",
		flagValues: { width: 1024, height: 1024, steps: 20, cfg_scale: 7.0 },
	},
	{
		value: "flux-schnell",
		label: "FLUX.1 schnell",
		bundle: "flux1",
		flagValues: { width: 1024, height: 1024, steps: 4, cfg_scale: 1.0 },
	},
	{
		value: "low-vram",
		label: "Low VRAM",
		bundle: "sd1",
		flagValues: {
			width: 512,
			height: 512,
			steps: 15,
			offload_to_cpu: true,
			clip_on_cpu: true,
		},
	},
];

window.SDGui.DIMENSION_PRESETS = [
	{ value: "512x512", label: "1:1 - 512 x 512", width: 512, height: 512 },
	{ value: "768x768", label: "1:1 - 768 x 768", width: 768, height: 768 },
	{ value: "1024x1024", label: "1:1 - 1024 x 1024", width: 1024, height: 1024 },
	{ value: "768x512", label: "3:2 - 768 x 512", width: 768, height: 512 },
	{ value: "1152x768", label: "3:2 - 1152 x 768", width: 1152, height: 768 },
	{ value: "512x768", label: "2:3 - 512 x 768", width: 512, height: 768 },
	{ value: "768x1152", label: "2:3 - 768 x 1152", width: 768, height: 1152 },
	{ value: "768x576", label: "4:3 - 768 x 576", width: 768, height: 576 },
	{ value: "1024x768", label: "4:3 - 1024 x 768", width: 1024, height: 768 },
	{ value: "576x768", label: "3:4 - 576 x 768", width: 576, height: 768 },
	{ value: "768x1024", label: "3:4 - 768 x 1024", width: 768, height: 1024 },
	{ value: "1024x576", label: "16:9 - 1024 x 576", width: 1024, height: 576 },
	{ value: "1344x768", label: "16:9 - 1344 x 768", width: 1344, height: 768 },
	{ value: "576x1024", label: "9:16 - 576 x 1024", width: 576, height: 1024 },
	{ value: "768x1344", label: "9:16 - 768 x 1344", width: 768, height: 1344 },
];

// ── Dimensions widget (Generate tab): "Aspect → Size" redesign ───────────
// Ordered aspect-ratio "shapes" shown as proportional chips. `ratio` = w/h.
// `glyph` sizes the little preview rectangle inside the chip ([w, h] px).
window.SDGui.DIMENSION_SHAPES = [
	{ shape: "1:1", ratio: 1.0, glyph: [18, 18] },
	{ shape: "3:2", ratio: 1.5, glyph: [22, 15] },
	{ shape: "2:3", ratio: 0.6667, glyph: [15, 22] },
	{ shape: "4:3", ratio: 1.3333, glyph: [22, 17] },
	{ shape: "3:4", ratio: 0.75, glyph: [17, 22] },
	{ shape: "16:9", ratio: 1.7778, glyph: [22, 13] },
	{ shape: "9:16", ratio: 0.5625, glyph: [13, 22] },
];

// Map an arbitrary w/h ratio to the nearest known shape, or null if it falls
// outside tolerance (i.e. a truly custom ratio).
window.SDGui.shapeFromRatio = (ratio) => {
	if (!ratio || ratio <= 0) return null;
	var shapes = window.SDGui.DIMENSION_SHAPES || [];
	var best = null;
	var bestD = 0.04;
	for (var i = 0; i < shapes.length; i++) {
		var d = Math.abs(shapes[i].ratio - ratio);
		if (d < bestD) {
			bestD = d;
			best = shapes[i].shape;
		}
	}
	return best;
};

// Derive per-shape "smart buckets" from DIMENSION_PRESETS: each shape lists
// its canonical longer-edge sizes, ascending. Clicking shape + size always
// lands on a quality-correct SD1/SDXL resolution (never an off-bucket guess).
(function buildDimensionBuckets() {
	var buckets = {}; // shape -> [{ long, width, height }]
	(window.SDGui.DIMENSION_PRESETS || []).forEach((p) => {
		var shape = window.SDGui.shapeFromRatio(p.width / p.height);
		if (!shape) return;
		if (!buckets[shape]) buckets[shape] = [];
		buckets[shape].push({
			long: Math.max(p.width, p.height),
			width: p.width,
			height: p.height,
		});
	});
	Object.keys(buckets).forEach((k) => {
		buckets[k].sort((a, b) => a.long - b.long);
	});
	window.SDGui.DIMENSION_BUCKETS = buckets;
})();
