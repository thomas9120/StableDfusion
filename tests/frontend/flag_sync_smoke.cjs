// Playwright frontend smoke test (Phase 2 + Phase 3, PLAN.md §17).
// Serves ui/ as the web root, stubs the backend /api/* endpoints, and verifies:
//   - flag definitions validate cleanly at startup
//   - Generate builds launch args from shared flagCore state
//   - Generate <-> Configure state sync (editing width updates command preview)
//   - Generate click -> POST /api/generate -> poll status -> preview <img>
//     refreshes on mtime change -> on done, result lands in gallery + a history
//     entry is written (localStorage)
//   - Phase 3: bundle change applies defaults + switches mode (wan → vid_gen)
//   - Phase 3: mode-specific sections hide/show correctly per active mode
//   - Phase 3: HF download UI initializes without errors and lists files from
//     a stubbed /api/hf/repo-files response
//
// Run: npx playwright test or `node tests/frontend/flag_sync_smoke.cjs`
"use strict";

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UI_DIR = path.resolve(__dirname, "..", "..", "ui");
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
};

// 1x1 transparent PNG bytes for the preview/result stub.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function assembleIndex() {
	const shell = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
	return shell.replace(/<!--\s*@partial\s+([\w-]+)\s*-->/g, (_m, name) => {
		const partial = path.join(UI_DIR, "partials", `${name}.html`);
		return fs.existsSync(partial) ? fs.readFileSync(partial, "utf8") : _m;
	});
}

function startStaticServer() {
	const server = http.createServer((req, res) => {
		let urlPath = decodeURIComponent(req.url.split("?")[0]);
		if (urlPath === "/") urlPath = "/index.html";
		if (urlPath === "/index.html") {
			res.writeHead(200, { "Content-Type": MIME[".html"] });
			res.end(assembleIndex());
			return;
		}
		const filePath = path.join(UI_DIR, urlPath);
		if (
			!filePath.startsWith(UI_DIR) ||
			!fs.existsSync(filePath) ||
			fs.statSync(filePath).isDirectory()
		) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const ext = path.extname(filePath).toLowerCase();
		res.writeHead(200, {
			"Content-Type": MIME[ext] || "application/octet-stream",
		});
		fs.createReadStream(filePath).pipe(res);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

// Playwright's bundled browser version may not match what's installed; detect
// any available Chromium build under the standard ms-playwright cache.
const PLAYWRIGHT_DIR = path.join(
	process.env.LOCALAPPDATA ||
		path.join(process.env.USERPROFILE || "", "AppData", "Local"),
	"ms-playwright",
);
function findChromiumExecutable() {
	let dirs = [];
	try {
		dirs = fs
			.readdirSync(PLAYWRIGHT_DIR)
			.filter((d) => d.startsWith("chromium-"));
	} catch (_e) {
		/* ignore */
	}
	dirs.sort().reverse(); // newest first
	for (const d of dirs) {
		const candidate = path.join(
			PLAYWRIGHT_DIR,
			d,
			"chrome-win64",
			"chrome.exe",
		);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

(async () => {
	const server = await startStaticServer();
	const port = server.address().port;
	const base = `http://127.0.0.1:${port}/`;
	let statusCalls = 0;
	let generateStarted = false;
	let generatePosted = null;
	let serverPosted = null;
	let shutdownRequested = false;
	let shutdownPosts = 0;
	let presetStore = [];
	const failures = [];

	function check(name, cond) {
		if (!cond) failures.push(name);
		console.log(`  ${cond ? "ok" : "FAIL"}  ${name}`);
	}

	const browser = await chromium.launch(
		findChromiumExecutable()
			? { executablePath: findChromiumExecutable() }
			: {},
	);
	try {
		const page = await browser.newPage();

		// Stub all /api/* endpoints.
		await page.route("**/api/**", (route) => {
			const url = route.request().url();
			const method = route.request().method();
			if (url.includes("/api/presets/shortcut") && method === "POST") {
				let parsed = {};
				try {
					parsed = JSON.parse(route.request().postData() || "{}");
				} catch (_e) {}
				const preset = presetStore.find((p) => p.name === parsed.name);
				return route.fulfill({
					status: preset ? 200 : 404,
					contentType: "application/json",
					body: JSON.stringify(
						preset
							? { filename: `${preset.name}.json`, preset }
							: { error: "Preset not found." },
					),
				});
			}
			if (url.endsWith("/api/presets") && method === "GET") {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ presets: presetStore }),
				});
			}
			if (url.endsWith("/api/presets") && method === "POST") {
				let parsed = {};
				try {
					parsed = JSON.parse(route.request().postData() || "{}");
				} catch (_e) {}
				const preset = Object.assign(
					{
						schema: 1,
						kind: "stable-d-gui.preset",
						updated_at: new Date().toISOString(),
					},
					parsed,
				);
				preset.bundle = preset.bundle || preset.model_type || "custom";
				preset.model_type = preset.bundle;
				presetStore = presetStore.filter((p) => p.name !== preset.name);
				presetStore.push(preset);
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ saved: true, preset }),
				});
			}
			if (url.includes("/api/models")) {
				const queryType = new URL(url).searchParams.get("type");
				if (queryType === "upscaler" || queryType === "esrgan") {
					return route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({
							models: [
								{
									name: "RealESRGAN_x4plus.pth",
									relative: "upscalers/RealESRGAN_x4plus.pth",
									folder: "upscalers",
									size: 123456,
									mtime: 1,
								},
							],
						}),
					});
				}
				if (queryType === "lora") {
					return route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({
							models: [
								{
									name: "style-test.safetensors",
									relative: "loras/style-test.safetensors",
									folder: "loras",
									size: 123456,
									mtime: 1,
								},
								{
									name: "detail-test.safetensors",
									relative: "loras/detail-test.safetensors",
									folder: "loras",
									size: 123456,
									mtime: 1,
								},
							],
						}),
					});
				}
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						models: [
							{
								name: "test.gguf",
								relative: "test.gguf",
								size: 123456,
								mtime: 1,
							},
						],
					}),
				});
			}
			if (url.includes("/api/status")) {
				if (shutdownRequested) return route.abort("failed");
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						installed: true,
						version: "smoke",
						backend: "cpu-avx2",
					}),
				});
			}
			if (url.includes("/api/shutdown") && method === "POST") {
				shutdownRequested = true;
				shutdownPosts += 1;
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ shutting_down: true }),
				});
			}
			if (url.includes("/api/sd-server/status")) {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						status: "idle",
						message: "sd-server is not running.",
					}),
				});
			}
			if (url.includes("/api/sd-server/start") && method === "POST") {
				try {
					serverPosted = JSON.parse(route.request().postData() || "{}");
				} catch (_e) {
					serverPosted = {};
				}
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						status: "running",
						message: "sd-server running at http://127.0.0.1:8123",
						target_url: "http://127.0.0.1:8123",
					}),
				});
			}
			if (url.includes("/api/generate/status")) {
				if (!generateStarted) {
					return route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ state: "idle" }),
					});
				}
				statusCalls += 1;
				const running = statusCalls <= 2;
				const postedMode =
					generatePosted && generatePosted.mode ? generatePosted.mode : "img_gen";
				const body = running
					? {
							state: "running",
							job_id: "smoke_job",
							mode: postedMode,
							step: 5,
							total_steps: 20,
							percent: 25,
							preview_mtime: 1000 + statusCalls,
							message: "Step 5/20",
						}
					: {
							state: "done",
							job_id: "smoke_job",
							mode: postedMode,
							step: 20,
							total_steps: 20,
							percent: 100,
							result_files: postedMode === "metadata" ? [] : ["smoke.png"],
							prompt: "a cat",
							stdout_excerpt: "prompt: a cat",
							message: "Done — 1 image(s) saved.",
						};
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(body),
				});
			}
			if (url.includes("/api/generate/preview")) {
				return route.fulfill({
					status: 200,
					contentType: "image/png",
					body: TINY_PNG,
				});
			}
			if (url.includes("/api/generate") && method === "POST") {
				let parsed = {};
				try {
					parsed = JSON.parse(route.request().postData() || "{}");
				} catch (_e) {}
				generatePosted = parsed;
				generateStarted = true;
				statusCalls = 0;
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ job_id: "smoke_job" }),
				});
			}
			// Default stub for any other /api call (select-file, open-folder, images...).
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});

		const errors = [];
		page.on("console", (m) => {
			if (m.type() === "error") errors.push(m.text());
		});
		page.on("pageerror", (e) => errors.push(String(e)));
		let navigationCount = 0;
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) navigationCount += 1;
		});

		await page.goto(base, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(
			() =>
				!!(window.SDGui && window.SDGui.generateUi && window.SDGui.flagCore),
		);

		await page.click('.nav-item[data-section="install"]');
		await page.waitForTimeout(40);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(
			() =>
				document.getElementById("section-install").style.display === "block",
			{ timeout: 3000 },
		);
		const persistedTab = await page.evaluate(() => ({
			active: document
				.querySelector('.nav-item[data-section="install"]')
				.classList.contains("active"),
			stored: localStorage.getItem(window.SDGui.ACTIVE_SECTION_KEY),
		}));
		check(
			"active tab persists across app reloads",
			persistedTab.active && persistedTab.stored === "install",
		);
		await page.evaluate(() =>
			localStorage.setItem(window.SDGui.ACTIVE_SECTION_KEY, "generate"),
		);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(
			() =>
				document.getElementById("section-generate-image").style.display ===
				"block",
			{ timeout: 3000 },
		);
		const migratedGenerateTab = await page.evaluate(() => ({
			active: document
				.querySelector('.nav-item[data-section="generate-image"]')
				.classList.contains("active"),
			stored: localStorage.getItem(window.SDGui.ACTIVE_SECTION_KEY),
		}));
		check(
			"legacy generate tab migrates to Generate Image",
			migratedGenerateTab.active &&
				migratedGenerateTab.stored === "generate-image",
		);
		await page.click('.nav-item[data-section="generate-image"]');

		// 1. Flag definitions validate.
		const validation = await page.evaluate(() =>
			window.SDGui.validateFlagDefinitions(),
		);
		check("flag definitions validate cleanly", validation.ok);
		if (!validation.ok) console.log("    warnings:", validation.warnings);

		// 2. flagCore.getLaunchArgs builds args including the model.
		const setModel = await page.evaluate(() => {
			window.SDGui.flagCore.setFlagValue("model", "test.gguf");
			window.SDGui.flagCore.setFlagValue("prompt", "a cat");
			return window.SDGui.flagCore.getLaunchArgs();
		});
		const flatArgs = (setModel.args || []).map((p) => p.join("=")).join(" ");
		check(
			"getLaunchArgs emits the model flag",
			flatArgs.includes("--model=test.gguf"),
		);
		check(
			"getLaunchArgs emits the prompt",
			flatArgs.includes("--prompt=a cat"),
		);
		check("getLaunchArgs has no error", !setModel.error);

		// 3. Generate <-> Configure sync: edit width in Generate, verify command preview.
		await page.evaluate(() => window.SDGui.flagCore.setFlagValue("width", 768));
		// Command preview lives in Configure tab; render it then read.
		await page.evaluate(() => window.SDGui.configFlagsUi.render());
		const previewText = await page.evaluate(
			() => document.getElementById("command-preview").textContent,
		);
		check(
			"Configure command preview reflects shared width=768",
			previewText.includes("--width") && previewText.includes("768"),
		);

		// 3b. Dimensions widget (Aspect → Size): pick 16:9, then its 1344
		// longer-edge bucket, which must flow through shared flag state.
		await page.click('#gen-dim-shapes .dim-shape[data-shape="16:9"]');
		await page.waitForTimeout(40);
		await page.click('#gen-dim-sizes .dim-size[data-long="1344"]');
		await page.waitForTimeout(60);
		const bucketDims = await page.evaluate(() => ({
			width: window.SDGui.flagCore.getFlagValues().width,
			height: window.SDGui.flagCore.getFlagValues().height,
			widthInput: document.getElementById("gen-width").value,
			heightInput: document.getElementById("gen-height").value,
		}));
		check(
			"dimension bucket writes width/height through shared flag state",
			bucketDims.width === 1344 &&
				bucketDims.height === 768 &&
				bucketDims.widthInput === "1344" &&
				bucketDims.heightInput === "768",
		);
		// Manual edit returns the size selection to Custom. The exact inputs
		// live inside a collapsed <details>; clicking Custom opens it + focuses
		// the width field, so drive entry through that path.
		await page.click('#gen-dim-sizes .dim-size[data-long="custom"]');
		await page.waitForTimeout(40);
		await page.fill("#gen-width", "832");
		await page.dispatchEvent("#gen-width", "change");
		await page.waitForTimeout(60);
		const customActive = await page.evaluate(() => {
			const c = document.querySelector(
				'#gen-dim-sizes .dim-size[data-long="custom"]',
			);
			return c ? c.classList.contains("active") : false;
		});
		check(
			"manual dimension edit returns size selection to Custom",
			customActive,
		);

		// 4. Pick a model via the Generate picker so generate() has a model.
		await page.selectOption("#gen-model-bundle", "sd1");
		await page.waitForTimeout(150);
		// Explicitly guarantee the model + prompt are in shared state.
		await page.evaluate(() => {
			window.SDGui.flagCore.setFlagValue("model", "test.gguf");
			window.SDGui.flagCore.setFlagValue("prompt", "a cat");
		});
		await page.fill("#gen-prompt", "a cat");
		await page
			.locator("#gen-model-components .lora-row select")
			.first()
			.selectOption("models/loras/style-test.safetensors");
		await page
			.locator("#gen-model-components .lora-row input[type='range']")
			.first()
			.evaluate((slider) => {
				slider.value = "0.75";
				slider.dispatchEvent(new Event("input", { bubbles: true }));
			});
		await page.getByRole("button", { name: "Add LoRA" }).click();
		await page
			.locator("#gen-model-components .lora-row select")
			.nth(1)
			.selectOption("models/loras/detail-test.safetensors");
		await page
			.locator("#gen-model-components .lora-row input[type='range']")
			.nth(1)
			.evaluate((slider) => {
				slider.value = "0.4";
				slider.dispatchEvent(new Event("input", { bubbles: true }));
			});
		const loraUi = await page.evaluate(() => {
			const ranges = Array.from(
				document.querySelectorAll("#gen-model-components .lora-row input[type='range']"),
			);
			const state = window.SDGui.flagCore.getFlagValues().lora_files || [];
			return (
				ranges.length >= 2 &&
				ranges.every((input) => input.min === "-1" && input.max === "2") &&
				state.length === 2
			);
		});
		check("LoRA strength slider is rendered with expected range", loraUi);

		// 5. Click Generate -> posts + polls.
		await page.click("#btn-generate");
		try {
			await page.waitForFunction(
				() => {
					const img = document.getElementById("gen-preview");
					return (
						img && !img.hidden && img.src.includes("/api/generate/preview")
					);
				},
				{ timeout: 6000 },
			);
			check("preview <img> shown during running state", true);
		} catch (e) {
			const diag = await page.evaluate(
				() => document.getElementById("gen-progress-text").textContent,
			);
			console.log("    diag progress text:", diag, "errors:", errors);
			check("preview <img> shown during running state", false);
		}

		// 6. Wait for done -> result image + history entry.
		await page.waitForFunction(
			() => {
				const box = document.getElementById("gen-result");
				return box && box.querySelector("img");
			},
			{ timeout: 8000 },
		);
		const resultCount = await page.evaluate(
			() => document.querySelectorAll("#gen-result img").length,
		);
		check("result image rendered on done", resultCount >= 1);
		await page.click('.nav-item[data-section="generate-video"]');
		await page.waitForTimeout(80);
		const videoResultCount = await page.evaluate(
			() => document.querySelectorAll("#gen-result img, #gen-result video").length,
		);
		check(
			"video tab does not inherit image result frame",
			videoResultCount === 0,
		);
		await page.click('.nav-item[data-section="generate-image"]');
		await page.waitForTimeout(80);
		const restoredImageResultCount = await page.evaluate(
			() => document.querySelectorAll("#gen-result img").length,
		);
		check(
			"image result frame restores after tab switch",
			restoredImageResultCount >= 1,
		);

		const historyCount = await page.evaluate(
			() => document.querySelectorAll("#gen-history .history-item").length,
		);
		check("history entry written on done", historyCount >= 1);

		// 7. POST body included mode + args + total_steps.
		check(
			"Generate POST included mode img_gen",
			generatePosted && generatePosted.mode === "img_gen",
		);
		check(
			"Generate POST included args array",
			!!(generatePosted && Array.isArray(generatePosted.args)),
		);
		check(
			"Generate POST included total_steps",
			generatePosted && Number.isInteger(generatePosted.total_steps),
		);
		const postedArgs = (generatePosted.args || [])
			.map((p) => p.join("="))
			.join(" ");
		check(
			"Generate POST injected LoRA prompt tag",
			postedArgs.includes(
				"--prompt=a cat <lora:style-test:0.75> <lora:detail-test:0.4>",
			),
		);
		check(
			"Generate POST included LoRA model dir",
			postedArgs.includes("--lora-model-dir=models/loras"),
		);

		// 8. No uncaught page errors.
		check("no uncaught page errors", errors.length === 0);
		if (errors.length) console.log("    page errors:", errors);

		// 9. History persisted to localStorage.
		const stored = await page.evaluate(() =>
			localStorage.getItem("sdgui.generate.history"),
		);
		check(
			"history persisted to localStorage",
			!!stored && stored.includes("a cat"),
		);

		// 9b. History UI: count badge updates, each item has the 5-action
		// toolbar, the new entries carry the real `file` field, deleting one
		// entry removes only it, and Clear wipes the list without touching
		// other localStorage keys.
		const histUI = await page.evaluate(async () => {
			const itemsBefore = document.querySelectorAll(
				"#gen-history .history-item",
			).length;
			const countBadge =
				document.getElementById("gen-history-count")?.textContent;
			const hasFile = JSON.parse(
				localStorage.getItem("sdgui.generate.history") || "[]",
			).some((e) => e.file);
			const toolbarActions = document.querySelectorAll(
				"#gen-history .history-item .history-action",
			).length;
			// Remove the first entry via its delete button.
			const before = JSON.parse(
				localStorage.getItem("sdgui.generate.history") || "[]",
			).length;
			document.querySelector("#gen-history .history-action.danger")?.click();
			const afterDelete = JSON.parse(
				localStorage.getItem("sdgui.generate.history") || "[]",
			).length;
			// Clear-all via the header button (auto-confirms in this stub-free
			// context by clicking OK).
			document.getElementById("btn-clear-history")?.click();
			const okBtn = document.getElementById("confirm-modal-ok");
			if (okBtn) okBtn.click();
			await new Promise((r) => setTimeout(r, 30));
			const afterClear = localStorage.getItem("sdgui.generate.history");
			const itemsAfterClear = document.querySelectorAll(
				"#gen-history .history-item",
			).length;
			const emptyShown = !!document.querySelector(
				"#gen-history .history-empty",
			);
			return {
				itemsBefore,
				countBadge,
				hasFile,
				toolbarActions,
				before,
				afterDelete,
				afterClear,
				itemsAfterClear,
				emptyShown,
			};
		});
		check(
			"history count badge reflects entry count",
			Number(histUI.countBadge) === histUI.itemsBefore &&
				histUI.itemsBefore >= 1,
		);
		check(
			"history entries store the real on-disk filename (file field)",
			histUI.hasFile,
		);
		check(
			"history items expose the 4-action toolbar",
			histUI.toolbarActions >= 4,
		);
		check(
			"delete-one removes exactly one entry",
			histUI.afterDelete === histUI.before - 1,
		);
		check(
			"Clear-all empties history list",
			histUI.afterClear === null &&
				histUI.itemsAfterClear === 0 &&
				histUI.emptyShown,
		);

		const filteredHistory = await page.evaluate(async () => {
			localStorage.setItem(
				"sdgui.generate.history",
				JSON.stringify([
					{
						id: "img",
						file: "image-smoke.png",
						prompt: "image",
						timestamp: Date.now(),
						mode: "img_gen",
						params: {},
					},
					{
						id: "vid",
						file: "video-smoke.webm",
						prompt: "video",
						timestamp: Date.now(),
						mode: "vid_gen",
						params: {},
					},
					{
						id: "up",
						file: "upscale-smoke.png",
						prompt: "upscale",
						timestamp: Date.now(),
						mode: "upscale",
						params: {},
					},
				]),
			);
			const nav = async (section) => {
				document
					.querySelector(`.nav-item[data-section="${section}"]`)
					.click();
				await new Promise((r) => setTimeout(r, 80));
				return Array.from(
					document.querySelectorAll("#gen-history .history-item"),
				).map((item) => item.getAttribute("data-id"));
			};
			return {
				image: await nav("generate-image"),
				video: await nav("generate-video"),
				upscale: await nav("upscale"),
			};
		});
		check(
			"Generate Image history filters image entries",
			filteredHistory.image.length === 1 && filteredHistory.image[0] === "img",
		);
		check(
			"Generate Video history filters video entries",
			filteredHistory.video.length === 1 && filteredHistory.video[0] === "vid",
		);
		check(
			"Upscale history filters upscale entries",
			filteredHistory.upscale.length === 1 &&
				filteredHistory.upscale[0] === "up",
		);

		// ── Phase 4: preset save/load preserves flagCore state + custom args.
		await page.evaluate(() => {
			window.SDGui.flagCore.setMode("img_gen");
			window.SDGui.flagCore.setBundle("sdxl", false);
			window.SDGui.flagCore.setMultipleFlagValues({
				model: "test.gguf",
				prompt: "preset cat",
				custom_args: "--eta 0.25",
			});
		});
		await page.click('.nav-item[data-section="presets"]');
		await page.fill("#preset-name", "Smoke Preset");
		await page.fill("#preset-description", "saved by smoke");
		await page.click("#btn-save-preset");
		await page.waitForFunction(
			() => document.querySelectorAll("#presets-list .preset-row").length > 0,
			{ timeout: 3000 },
		);
		check("preset saved through UI", presetStore.length === 1);
		await page.evaluate(() => {
			window.SDGui.flagCore.setFlagValue("prompt", "changed");
			window.SDGui.flagCore.setFlagValue("custom_args", "");
		});
		await page.click("#presets-list .preset-row .btn-primary");
		const restoredPreset = await page.evaluate(() => ({
			prompt: window.SDGui.flagCore.getFlagValues().prompt,
			custom_args: window.SDGui.flagCore.getFlagValues().custom_args,
			bundle: window.SDGui.flagCore.getBundle(),
		}));
		check(
			"preset load restored prompt",
			restoredPreset.prompt === "preset cat",
		);
		check(
			"preset load restored custom args",
			restoredPreset.custom_args === "--eta 0.25",
		);
		check("preset load restored bundle", restoredPreset.bundle === "sdxl");

		// Preset import accepts both exported-bundle and single-preset shapes.
		const importDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdgui-presets-"));
		const importBundlePath = path.join(importDir, "bundle.json");
		const importSinglePath = path.join(importDir, "single.json");
		fs.writeFileSync(
			importBundlePath,
			JSON.stringify({
				schema: 1,
				kind: "stable-d-gui.preset-bundle",
				presets: [
					{
						name: "Imported Bundle Preset",
						bundle: "sd1",
						mode: "img_gen",
						values: { prompt: "bundle import" },
					},
				],
			}),
		);
		fs.writeFileSync(
			importSinglePath,
			JSON.stringify({
				preset: {
					name: "Imported Single Preset",
					bundle: "flux1",
					mode: "img_gen",
					values: { prompt: "single import" },
				},
			}),
		);
		await page.setInputFiles("#preset-import-file", importBundlePath);
		await page.waitForFunction(
			() =>
				Array.from(
					document.querySelectorAll("#presets-list .preset-title"),
				).some((n) => n.textContent === "Imported Bundle Preset"),
			{ timeout: 3000 },
		);
		check(
			"preset import accepted bundle export shape",
			presetStore.some((p) => p.name === "Imported Bundle Preset"),
		);
		await page.setInputFiles("#preset-import-file", importSinglePath);
		await page.waitForFunction(
			() =>
				Array.from(
					document.querySelectorAll("#presets-list .preset-title"),
				).some((n) => n.textContent === "Imported Single Preset"),
			{ timeout: 3000 },
		);
		check(
			"preset import accepted single preset shape",
			presetStore.some((p) => p.name === "Imported Single Preset"),
		);

		// Server UI posts the same curated contract that server_mode_service expects.
		await page.click('.nav-item[data-section="server"]');
		await page.fill("#server-listen_port", "8123");
		await page.locator(".server-advanced").evaluate((el) => {
			el.open = true;
		});
		await page.fill("#server-diffusion_model", "models/diffusion/server.gguf");
		await page.check("#server-diffusion_fa");
		await page.fill("#server-extra-args", "--cache-mode easycache");
		await page.click("#btn-sd-server-start");
		await page.waitForTimeout(100);
		check(
			"Server UI POST included listener",
			serverPosted &&
				serverPosted.host === "127.0.0.1" &&
				serverPosted.port === 8123,
		);
		const serverPostedArgs = (
			serverPosted && serverPosted.args ? serverPosted.args : []
		)
			.map((p) => p.join("="))
			.join(" ");
		check(
			"Server UI POST included diffusion model",
			serverPostedArgs.includes(
				"--diffusion-model=models/diffusion/server.gguf",
			),
		);
		check(
			"Server UI POST included bool and extra args",
			serverPostedArgs.includes("--diffusion-fa") &&
				serverPosted &&
				serverPosted.extra_args === "--cache-mode easycache",
		);

		await page.click('.nav-item[data-section="generate-image"]');

		// ── Phase 3 ─────────────────────────────────────────────────────────
		// Bundle change applies defaults + switches mode (wan → vid_gen).
		await page.selectOption("#gen-model-bundle", "wan");
		await page.waitForTimeout(150);
		const afterWan = await page.evaluate(() => ({
			mode: window.SDGui.flagCore.getMode(),
			video_frames: window.SDGui.flagCore.getFlagValues().video_frames,
			fps: window.SDGui.flagCore.getFlagValues().fps,
			activeSection: localStorage.getItem(window.SDGui.ACTIVE_SECTION_KEY),
		}));
		check("wan bundle switches mode to vid_gen", afterWan.mode === "vid_gen");
		check(
			"wan bundle routes to Generate Video tab",
			afterWan.activeSection === "generate-video",
		);
		check(
			"wan bundle defaults include video_frames=25",
			afterWan.video_frames === 25,
		);
		check("wan bundle defaults include fps=16", afterWan.fps === 16);

		// Mode-specific top-level tabs route to the matching sd-cli mode.
		const sectionVisibility = async (section) => {
			await page.click(`.nav-item[data-section="${section}"]`);
			await page.waitForTimeout(80);
			return await page.evaluate(() => {
				const isHidden = (id) => {
					const n = document.getElementById(id);
					return !n || n.classList.contains("hidden");
				};
				return {
					mode: window.SDGui.flagCore.getMode(),
					img2img: isHidden("gen-img2img-inputs"),
					video: isHidden("gen-video-inputs"),
					upscale: isHidden("gen-upscale-inputs"),
					convert: isHidden("gen-convert-inputs"),
					metadata: isHidden("gen-metadata-inputs"),
					prompt: isHidden("gen-prompt-section"),
					sampling: isHidden("gen-sampling-section"),
					activeSection: localStorage.getItem(window.SDGui.ACTIVE_SECTION_KEY),
				};
			});
		};

		const imgGen = await sectionVisibility("generate-image");
		check("Generate Image tab sets img_gen mode", imgGen.mode === "img_gen");
		check("img_gen shows img2img inputs", !imgGen.img2img);
		check(
			"img_gen hides video/upscale/convert",
			imgGen.video && imgGen.upscale && imgGen.convert,
		);
		check("metadata inspector stays with Generate Image", !imgGen.metadata);
		check("img_gen shows prompt section", !imgGen.prompt);

		const videoVis = await sectionVisibility("generate-video");
		check("Generate Video tab sets vid_gen mode", videoVis.mode === "vid_gen");
		check("video tab shows video inputs", !videoVis.video);
		check("video tab hides image metadata inspector", videoVis.metadata);

		const upscaleVis = await sectionVisibility("upscale");
		check("Upscale tab sets upscale mode", upscaleVis.mode === "upscale");
		check("upscale shows upscale inputs", !upscaleVis.upscale);
		check("upscale hides img2img inputs", upscaleVis.img2img);
		check("upscale hides prompt section", upscaleVis.prompt);
		const upscaleOptions = await page.evaluate(() =>
			Array.from(document.querySelectorAll("#gen-upscale-model option")).map(
				(o) => o.value,
			),
		);
		check(
			"upscale model dropdown lists upscalers folder",
			upscaleOptions.includes("models/upscalers/RealESRGAN_x4plus.pth"),
		);

		const convertVis = await sectionVisibility("convert");
		check("Convert tab sets convert mode", convertVis.mode === "convert");
		check("convert shows convert inputs", !convertVis.convert);
		check("convert hides prompt section", convertVis.prompt);

		// Mode-specific required-input errors surface correctly.
		const upscaleErr = await page.evaluate(() => {
			window.SDGui.flagCore.setMode("upscale");
			window.SDGui.flagCore.setFlagValue("init_img", "");
			window.SDGui.flagCore.setFlagValue("upscale_model", "");
			return window.SDGui.flagCore.getLaunchArgs().error || "";
		});
		check("upscale error mentions init_img", upscaleErr.includes("init image"));
		const metadataErr = await page.evaluate(() => {
			window.SDGui.flagCore.setMode("metadata");
			window.SDGui.flagCore.setFlagValue("image", "");
			return window.SDGui.flagCore.getLaunchArgs().error || "";
		});
		check("metadata error mentions image", metadataErr.includes("image"));

		await page.click('.nav-item[data-section="generate-image"]');
		await page.evaluate(() => {
			window.SDGui.flagCore.setFlagValue("image", "output/smoke.png");
			const details = document.querySelector(".metadata-details");
			if (details) details.open = true;
		});
		await page.click("#btn-inspect-metadata");
		await page.waitForFunction(
			() => {
				const box = document.getElementById("gen-result");
				return box && box.querySelector(".result-text");
			},
			{ timeout: 8000 },
		);
		const metadataPosted = await page.evaluate(() => ({
			mode: window.SDGui.flagCore.getMode(),
			resultText: document.querySelector("#gen-result .result-text")?.textContent || "",
		}));
		check(
			"metadata inspect posts metadata mode",
			generatePosted && generatePosted.mode === "metadata",
		);
		check("metadata inspect restores image mode", metadataPosted.mode === "img_gen");
		check(
			"metadata inspect renders stdout text",
			metadataPosted.resultText.includes("prompt: a cat"),
		);

		// Reset to img_gen so the rest of the page is in a sane state.
		await page.click('.nav-item[data-section="generate-image"]');

		// ── init_img mirror sync: init_img is bound to TWO inputs
		// (gen-init-img in the img2img panel + gen-upscale-init-img in the
		// upscale panel). Setting the flag via the shared setter (the path used
		// by both "Send to img2img" and the Browse button) must populate BOTH
		// fields, not just one.
		await page.evaluate(() =>
			window.SDGui.flagCore.setFlagValue("init_img", "output/sample.png"),
		);
		await page.waitForTimeout(60);
		const initImgImgGen = await page.inputValue("#gen-init-img");
		check(
			"init_img setFlagValue populates visible img2img field",
			initImgImgGen === "output/sample.png",
		);
		// Switch to upscale: the mirrored upscale field must reflect the same state.
		await page.click('.nav-item[data-section="upscale"]');
		await page.waitForTimeout(60);
		const initImgUpscale = await page.inputValue("#gen-upscale-init-img");
		check(
			"init_img mirror keeps upscale field in sync",
			initImgUpscale === "output/sample.png",
		);
		// Edit through the upscale field; the img2img field must follow (both
		// write to the same flag, so the mirror is bidirectional).
		await page.fill("#gen-upscale-init-img", "output/other.png");
		await page.waitForTimeout(60);
		await page.click('.nav-item[data-section="generate-image"]');
		await page.waitForTimeout(60);
		const initImgRoundTrip = await page.inputValue("#gen-init-img");
		check(
			"init_img edit from upscale reflects in img2img field",
			initImgRoundTrip === "output/other.png",
		);
		// Reset for the rest of the suite.
		await page.evaluate(() =>
			window.SDGui.flagCore.setFlagValue("init_img", ""),
		);
		await page.click('.nav-item[data-section="generate-image"]');

		// Install-tab lifecycle: Stop GUI Server should request shutdown and
		// leave the current page alone. A forced reload here would fall back to
		// the Generate tab and make shutdown look like an app restart.
		await page.click('.nav-item[data-section="install"]');
		const stopNavBase = navigationCount;
		await page.click("#btn-stop-app");
		await page.click("#confirm-modal-ok");
		await page.waitForFunction(
			() => document.getElementById("install-status").textContent,
			{ timeout: 3000 },
		);
		await page.waitForTimeout(1800);
		const stopState = await page.evaluate(() => ({
			activeInstall: document
				.querySelector('.nav-item[data-section="install"]')
				.classList.contains("active"),
			status: document.getElementById("install-status").textContent,
		}));
		check("Stop GUI Server posts shutdown", shutdownPosts === 1);
		check(
			"Stop GUI Server does not reload the app",
			navigationCount === stopNavBase && stopState.activeInstall,
		);
		check(
			"Stop GUI Server reports disconnected state",
			/stopped|Shutdown requested/.test(stopState.status),
		);

		// HF download tab initializes without errors + lists files from stub.
		const repoFilesBody = JSON.stringify({
			files: [
				{ name: "flux1-schnell-q4_0.gguf", size: 4_500_000_000 },
				{ name: "ae.safetensors", size: 320_000_000 },
				{ name: "clip_l.safetensors", size: 250_000_000 },
				{ name: "README.md", size: 1000 },
			],
			revision: "main",
			count: 4,
			total_size: 5_070_001_000,
		});
		// Stub HF repo-files endpoint specifically; other endpoints already stubbed.
		await page.unroute("**/api/**");
		await page.route("**/api/**", (route) => {
			const url = route.request().url();
			if (url.includes("/api/hf/repo-files")) {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: repoFilesBody,
				});
			}
			if (url.includes("/api/hf/download")) {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ job_id: "smoke_hf", file_count: 1 }),
				});
			}
			if (url.includes("/api/hf/download-status")) {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ status: "idle" }),
				});
			}
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});

		await page.click('.nav-item[data-section="hf-download"]');
		await page.fill("#hf-repo-id", "city96/FLUX.1-schnell-gguf");
		await page.click("#btn-hf-fetch");
		await page.waitForFunction(
			() => document.querySelectorAll("#hf-file-list .hf-file-row").length > 0,
			{ timeout: 3000 },
		);
		const hfRowCount = await page.evaluate(
			() => document.querySelectorAll("#hf-file-list .hf-file-row").length,
		);
		check("HF file list rendered after Find Files", hfRowCount === 4);
		const hfStatus = await page.evaluate(
			() => document.getElementById("hf-status").textContent,
		);
		check("HF status reports file count", /Found 4 file/.test(hfStatus));
		const hfDownloadEnabled = await page.evaluate(
			() => !document.getElementById("btn-hf-download").disabled,
		);
		check("HF Download button enabled after auto-selection", hfDownloadEnabled);
	} finally {
		await browser.close();
		server.close();
	}

	console.log(
		`\n${failures.length === 0 ? "ALL SMOKE CHECKS PASSED" : failures.length + " CHECK(S) FAILED"}`,
	);
	if (failures.length) {
		failures.forEach((f) => console.log("  - " + f));
		process.exit(1);
	}
})().catch((err) => {
	console.error("smoke test crashed:", err);
	process.exit(1);
});
