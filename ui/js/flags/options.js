// Shared enum option lists for sd-cli flags.
// Authoritative source: run `<sdcpp>/bin/sd-cli -h` and read
// examples/common/common.cpp (SDContextParams/SDGenerationParams::get_options).
// Verify every value against the current upstream before exposing it (PLAN.md §9).

window.SDGui = window.SDGui || {};

window.SDGui.SAMPLING_METHODS = [
	"euler",
	"euler_a",
	"heun",
	"dpm2",
	"dpm++2m",
	"dpm++2mv2",
	"dpm++2s_a",
	"ipndm",
	"ipndm_v",
	"lcm",
];

window.SDGui.SCHEDULERS = [
	"default",
	"discrete",
	"karras",
	"exponential",
	"ays",
	"gits",
];

window.SDGui.WEIGHT_TYPES = [
	"f32",
	"f16",
	"q8_0",
	"q5_0",
	"q5_1",
	"q4_0",
	"q4_1",
];

window.SDGui.PREVIEW_METHODS = ["none", "proj", "tae", "vae"];

window.SDGui.RNG_TYPES = ["cuda", "std_default"];

window.SDGui.SD_MODES = [
	"img_gen",
	"vid_gen",
	"convert",
	"upscale",
	"metadata",
];
