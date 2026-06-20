// FLAG_CATEGORIES — drives the Configure tab's accordions.
window.SDGui = window.SDGui || {};

window.SDGui.FLAG_CATEGORIES = [
	{ id: "generation", label: "Generation", desc: "Prompt, dimensions, batch." },
	{
		id: "sampling",
		label: "Sampling",
		desc: "Steps, CFG, sampler, scheduler, seed.",
	},
	{
		id: "model_components",
		label: "Model Components",
		desc: "Model / VAE / CLIP / T5 / LLM paths.",
	},
	{
		id: "img2img",
		label: "Image-to-Image",
		desc: "Init image, mask, strength, control image.",
	},
	{
		id: "lora",
		label: "LoRA / ControlNet",
		desc: "LoRA dirs, weights, control nets.",
	},
	{
		id: "backend_gpu",
		label: "Backend & GPU",
		desc: "GPU layers, threads, flash attn, offload.",
	},
	{ id: "video", label: "Video", desc: "Frames, fps, motion scale (Wan/LTX)." },
	{
		id: "output",
		label: "Output",
		desc: "Output path, format, metadata, preview.",
	},
	{
		id: "advanced",
		label: "Advanced",
		desc: "Weight type, tiling, backend selection, masks.",
	},
];
