// Shared enum option lists for sd-cli flags.
// Authoritative source: `<sdcpp>/bin/sd-cli -h` (commit 92a3b73) cross-checked
// against examples/common/common.cpp (SDContextParams/SDGenerationParams::get_options)
// and examples/cli/main.cpp. Verify every value against the current upstream before
// exposing it (PLAN.md §9 / AGENTS.md flag system).
window.SDGui = window.SDGui || {};

// sampling-method enum from `sd-cli -h` (--sampling-method).
window.SDGui.SAMPLING_METHODS = [
	"euler",
	"euler_a",
	"heun",
	"dpm2",
	"dpm++2s_a",
	"dpm++2m",
	"dpm++2mv2",
	"ipndm",
	"ipndm_v",
	"lcm",
	"ddim_trailing",
	"tcd",
	"res_multistep",
	"res_2s",
	"er_sde",
	"euler_cfg_pp",
	"euler_a_cfg_pp",
];

// scheduler enum from `sd-cli -h` (--scheduler).
window.SDGui.SCHEDULERS = [
	"default",
	"discrete",
	"karras",
	"exponential",
	"ays",
	"gits",
	"smoothstep",
	"sgm_uniform",
	"simple",
	"kl_optimal",
	"lcm",
	"bong_tangent",
	"ltx2",
];

// weight type enum from `sd-cli -h` (--type examples).
window.SDGui.WEIGHT_TYPES = [
	"default",
	"f32",
	"f16",
	"q8_0",
	"q5_0",
	"q5_1",
	"q4_0",
	"q4_1",
	"q4_K",
	"q3_K",
	"q2_K",
];

// preview method enum from `sd-cli -h` (--preview).
window.SDGui.PREVIEW_METHODS = ["none", "proj", "tae", "vae"];

// RNG enum from `sd-cli -h` (--rng).
window.SDGui.RNG_TYPES = ["cuda", "std_default", "cpu"];

// VAE latent format override (--vae-format).
window.SDGui.VAE_FORMATS = ["auto", "flux", "sd3", "flux2"];

// Prediction type override (--prediction). "default" is GUI-only and skipped.
window.SDGui.PREDICTION_TYPES = [
	"default",
	"eps",
	"v",
	"edm_v",
	"sd3_flow",
	"flux_flow",
	"flux2_flow",
];

// LoRA application mode (--lora-apply-mode).
window.SDGui.LORA_APPLY_MODES = ["auto", "immediately", "at_runtime"];

// SCM cache policy (--scm-policy).
window.SDGui.SCM_POLICIES = ["dynamic", "static"];

// sd-cli run modes (modes_str[] in examples/common/common.cpp).
window.SDGui.SD_MODES = ["img_gen", "vid_gen", "convert", "upscale", "metadata"];

// Default preview method the Generate tab uses so the live preview image ticks.
// sd-cli defaults to "none" (no preview), so Generate explicitly sets "vae".
window.SDGui.DEFAULT_PREVIEW_METHOD = "vae";
