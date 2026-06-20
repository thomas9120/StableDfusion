// Model-type bundles: drive which file-picker fields the Generate tab shows.
// Replaces LLama-GUI's chat-template presets. See PLAN.md §9.

window.SDGui = window.SDGui || {};

// Each bundle lists the model-component fields it needs and suggested defaults.
// `fields` values are file-picker purposes matching backend file_picker.PURPOSE_FILTERS.
window.SDGui.MODEL_TYPE_BUNDLES = [
	{
		value: "sd1",
		label: "SD 1.x / 2.x",
		fields: [{ key: "model", purpose: "model", required: true }],
		defaults: { width: 512, height: 512, steps: 20, cfg: 7.0 },
	},
	{
		value: "sdxl",
		label: "SDXL / SDXL-Turbo",
		fields: [
			{ key: "model", purpose: "model", required: true },
			{ key: "vae", purpose: "vae", required: false },
		],
		defaults: { width: 1024, height: 1024, steps: 20, cfg: 7.0 },
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
			width: 1024,
			height: 1024,
			steps: 30,
			cfg: 4.5,
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
			width: 1024,
			height: 1024,
			steps: 4,
			cfg: 1.0,
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
		defaults: { width: 1024, height: 1024, cfg: 1.0 },
	},
	{
		value: "qwen_image",
		label: "Qwen-Image / Edit",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: true },
		],
		defaults: { width: 1328, height: 1328 },
	},
	{
		value: "wan",
		label: "Wan2.1 / 2.2 (video)",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: true },
		],
		defaults: { mode: "vid_gen", video_frames: 25, fps: 16 },
	},
	{
		value: "z_image",
		label: "Z-Image",
		fields: [
			{ key: "diffusion_model", purpose: "diffusion_model", required: true },
			{ key: "vae", purpose: "vae", required: true },
			{ key: "llm", purpose: "llm", required: true },
		],
		defaults: { diffusion_fa: true, offload_to_cpu: true, cfg: 1.0 },
	},
	{
		value: "custom",
		label: "Custom (show all fields)",
		fields: "all",
		defaults: {},
	},
];
