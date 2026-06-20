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
