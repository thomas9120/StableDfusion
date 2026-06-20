// Model-type bundles: drive which file-picker fields the Generate tab shows.
// Replaces LLama-GUI's chat-template presets. See PLAN.md §9.

window.SDGui = window.SDGui || {};

// Each bundle lists the model-component fields it needs and suggested defaults.
// `fields` values are file-picker purposes matching backend file_picker.PURPOSE_FILTERS.
//
// `defaults` may include `mode` to switch the active sd-cli mode (consumed by
// flagCore.applyBundleDefaults). e.g. the wan bundle sets `mode: "vid_gen"`.
//
// `purpose` overrides the file-picker filter (rare; default = key).
window.SDGui.MODEL_TYPE_BUNDLES = [
	{
		value: "sd1",
		label: "SD 1.x / 2.x",
		fields: [{ key: "model", purpose: "model", required: true }],
		defaults: { mode: "img_gen", width: 512, height: 512, steps: 20, cfg_scale: 7.0 },
	},
	{
		value: "sdxl",
		label: "SDXL / SDXL-Turbo",
		fields: [
			{ key: "model", purpose: "model", required: true },
			{ key: "vae", purpose: "vae", required: false },
		],
		defaults: { mode: "img_gen", width: 1024, height: 1024, steps: 20, cfg_scale: 7.0 },
	},
	{
		value: "sd3",
		label: "SD3 / SD3.5",
		fields: [
			{ key: "model", purpose: "model", required: true },
			{ key: "clip_l", purpose: "clip_l", required: false },
			{ key: "clip_g", purpose: "clip_g", required: false },
			{ key: "t5xxl", purpose: "t5xxl", required: false },
		],
		defaults: {
			mode: "img_gen",
			width: 1024,
			height: 1024,
			steps: 30,
			cfg_scale: 4.5,
			clip_on_cpu: true,
		},
	},
	{
		value: "flux1",
		label: "FLUX.1 (dev/schnell)",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "clip_l", purpose: "clip_l", required: true },
			{ key: "t5xxl", purpose: "t5xxl", required: true },
		],
		defaults: {
			mode: "img_gen",
			width: 1024,
			height: 1024,
			steps: 4,
			cfg_scale: 1.0,
			clip_on_cpu: true,
		},
	},
	{
		value: "flux2",
		label: "FLUX.2",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: true },
		],
		defaults: { mode: "img_gen", width: 1024, height: 1024, cfg_scale: 1.0 },
	},
	{
		value: "qwen_image",
		label: "Qwen-Image / Edit",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: false },
		],
		defaults: { mode: "img_gen", width: 1328, height: 1328 },
	},
	{
		value: "wan",
		label: "Wan2.1 / 2.2 (video)",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: true },
		],
		defaults: { mode: "vid_gen", video_frames: 25, fps: 16, cfg_scale: 5.0 },
	},
	{
		value: "z_image",
		label: "Z-Image (Turbo)",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: true },
		],
		defaults: {
			mode: "img_gen",
			diffusion_fa: true,
			offload_to_cpu: true,
			cfg_scale: 1.0,
			steps: 8,
			vae_tiling: true,
		},
	},
	{
		value: "custom",
		label: "Custom (show all fields)",
		fields: [],
		defaults: { mode: "img_gen" },
	},
];

// Map each field key to its file-picker purpose (used by generate-ui.js to
// drive /api/models?type=…& /api/select-file filters).
window.SDGui.BUNDLE_FIELD_PURPOSES = {
	model: "model",
	diffusion_model: "diffusion_model",
	vae: "vae",
	clip_l: "clip_l",
	clip_g: "clip_g",
	clip_vision: "clip_vision",
	t5xxl: "t5xxl",
	llm: "llm",
	llm_vision: "llm_vision",
	taesd: "taesd",
	audio_vae: "audio_vae",
	high_noise_diffusion_model: "diffusion_model",
	uncond_diffusion_model: "diffusion_model",
	control_net: "control",
	embeddings_connectors: "model",
	lora_model_dir: "lora_model_dir",
	upscale_model: "upscaler",
	embd_dir: "model",
	hires_upscalers_dir: "upscaler",
	photo_maker: "model",
	pulid_weights: "model",
};
