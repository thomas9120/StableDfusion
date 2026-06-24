// Focused unit checks for ui/js/flag-core.js.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

function loadSdGui() {
	const context = vm.createContext({
		console,
		window: { SDGui: {} },
	});
	context.window.window = context.window;

	for (const rel of [
		"ui/js/app-data.js",
		"ui/js/flags/options.js",
		"ui/js/flags/model-bundles.js",
		"ui/js/flags/definitions.js",
		"ui/js/flags/helpers.js",
		"ui/js/flag-core.js",
	]) {
		const file = path.join(ROOT, rel);
		vm.runInContext(fs.readFileSync(file, "utf8"), context, {
			filename: file,
		});
	}
	return context.window.SDGui;
}

function flatPairs(args) {
	return (args || []).map((pair) => pair.join("="));
}

const SDGui = loadSdGui();
const flagCore = SDGui.flagCore;
const failures = [];

function check(name, fn) {
	try {
		fn();
		console.log("  ok  " + name);
	} catch (err) {
		failures.push(name);
		console.error("  FAIL  " + name);
		console.error("        " + (err && err.message ? err.message : err));
	}
}

check("custom args tokenizer preserves quoted whitespace", () => {
	assert.equal(
		JSON.stringify(flagCore.tokenizeCustomArgs('--eta "0.25 value" --dry-run')),
		JSON.stringify(["--eta", "0.25 value", "--dry-run"]),
	);
});

check("getLaunchArgs emits model and custom args after canonical args", () => {
	flagCore.resetToDefaults();
	flagCore.setMode("img_gen");
	flagCore.setMultipleFlagValues({
		model: "models/diffusion/sd15.gguf",
		prompt: "a cat",
		custom_args: '--eta "0.25 value"',
	});
	const result = flagCore.getLaunchArgs();
	const flat = flatPairs(result.args);
	assert.equal(result.error, null);
	assert(flat.includes("--model=models/diffusion/sd15.gguf"));
	assert(flat.includes("--prompt=a cat"));
	assert.equal(JSON.stringify(result.args.slice(-2)), JSON.stringify([["--eta"], ["0.25 value"]]));
});

check("backend-owned output and run mode flags are never emitted", () => {
	flagCore.resetToDefaults();
	flagCore.setMode("img_gen");
	flagCore.setMultipleFlagValues({
		model: "m.gguf",
		run_mode: "metadata",
		output: "evil.png",
		preview_path: "evil-preview.png",
	});
	const flags = flagCore.getLaunchArgs().args.map((pair) => pair[0]);
	const flat = flatPairs(flagCore.getLaunchArgs().args).join(" ");
	assert(!flags.includes("--mode"));
	assert(!flags.includes("--output"));
	assert(!flags.includes("--preview-path"));
	assert(!flat.includes("evil.png"));
});

check("upscale mode ignores stale generation model components", () => {
	flagCore.resetToDefaults();
	flagCore.setMode("upscale");
	flagCore.setMultipleFlagValues({
		model: "models/diffusion/sd15.gguf",
		diffusion_model: "models/diffusion/flux.gguf",
		vae: "models/vae/vae.gguf",
		init_img: "output/source.png",
		upscale_model: "models/upscalers/RealESRGAN_x4plus.pth",
		upscale_repeats: 2,
	});
	const result = flagCore.getLaunchArgs();
	const flat = flatPairs(result.args);
	assert.equal(result.error, null);
	assert(!flat.includes("--model=models/diffusion/sd15.gguf"));
	assert(!flat.includes("--diffusion-model=models/diffusion/flux.gguf"));
	assert(!flat.includes("--vae=models/vae/vae.gguf"));
	assert(flat.includes("--init-img=output/source.png"));
	assert(flat.includes("--upscale-model=models/upscalers/RealESRGAN_x4plus.pth"));
	assert(flat.includes("--upscale-repeats=2"));
});

check("invalid numeric values warn without entering argv", () => {
	flagCore.resetToDefaults();
	flagCore.setMode("img_gen");
	flagCore.setMultipleFlagValues({
		model: "m.gguf",
		width: "wide",
	});
	const result = flagCore.getLaunchArgs();
	const flat = flatPairs(result.args).join(" ");
	assert(result.warnings.some((w) => w.includes("Invalid number for width")));
	assert(!flat.includes("--width"));
	assert(!flat.includes("wide"));
});

check("Z-Image style llm equal to diffusion model blocks launch", () => {
	flagCore.resetToDefaults();
	flagCore.setMode("img_gen");
	flagCore.setMultipleFlagValues({
		diffusion_model: "models/diffusion/z-image.gguf",
		llm: "models/diffusion/z-image.gguf",
	});
	const result = flagCore.getLaunchArgs();
	assert(result.error.includes("LLM text encoder must be a separate file"));
	assert(!flatPairs(result.args).join(" ").includes("--llm"));
});

check("Krea 2 Turbo bundle applies its configured inference defaults", () => {
	flagCore.resetToDefaults();
	flagCore.setBundle("krea2", true);
	flagCore.setMultipleFlagValues({
		diffusion_model: "models/diffusion/krea-2-turbo.gguf",
		vae: "models/vae/wan-2.1-vae.safetensors",
		llm: "models/text-encoders/qwen3-vl-4b.gguf",
	});
	const values = flagCore.getFlagValues();
	const result = flagCore.getLaunchArgs();
	const flat = flatPairs(result.args);

	assert.equal(values.width, 2048);
	assert.equal(values.height, 2048);
	assert.equal(values.steps, 8);
	assert.equal(values.cfg_scale, 1);
	assert.equal(values.flow_shift, 0);
	assert.equal(values.sampling_method, "euler");
	assert.equal(values.diffusion_fa, true);
	assert.equal(values.offload_to_cpu, true);
	assert.equal(values.vae_tiling, true);
	assert.equal(result.error, null);
	assert(flat.includes("--steps=8"));
	assert(flat.includes("--cfg-scale=1"));
	assert(flat.includes("--flow-shift=0"));
	assert(flat.includes("--sampling-method=euler"));
	assert(flat.includes("--diffusion-fa"));
	assert(flat.includes("--offload-to-cpu"));
	assert(flat.includes("--vae-tiling"));
});

check("Generate Image dimension buckets move minimum and maximum up one tier", () => {
	assert.deepEqual(
		JSON.parse(JSON.stringify(SDGui.DIMENSION_BUCKETS["1:1"])),
		[
			{ long: 768, width: 768, height: 768 },
			{ long: 1024, width: 1024, height: 1024 },
			{ long: 1536, width: 1536, height: 1536 },
		],
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(SDGui.DIMENSION_BUCKETS["16:9"])),
		[
			{ long: 1344, width: 1344, height: 768 },
			{ long: 1536, width: 1536, height: 864 },
		],
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(SDGui.DIMENSION_BUCKETS["9:16"])),
		[
			{ long: 1344, width: 768, height: 1344 },
			{ long: 1536, width: 864, height: 1536 },
		],
	);
});

console.log(
	`\n${failures.length === 0 ? "ALL FLAG CORE UNIT CHECKS PASSED" : failures.length + " CHECK(S) FAILED"}`,
);
if (failures.length) process.exit(1);
