// Playwright frontend smoke test for Phase 2 (PLAN.md §17).
// Serves ui/ as the web root, stubs the backend /api/* endpoints, and verifies:
//   - flag definitions validate cleanly at startup
//   - Generate builds launch args from shared flagCore state
//   - Generate <-> Configure state sync (editing width updates command preview)
//   - Generate click -> POST /api/generate -> poll status -> preview <img>
//     refreshes on mtime change -> on done, result lands in gallery + a history
//     entry is written (localStorage)
//
// Run: npx playwright test or `node tests/frontend/flag_sync_smoke.cjs`
"use strict";

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
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

function startStaticServer() {
	const server = http.createServer((req, res) => {
		let urlPath = decodeURIComponent(req.url.split("?")[0]);
		if (urlPath === "/") urlPath = "/index.html";
		const filePath = path.join(UI_DIR, urlPath);
		if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const ext = path.extname(filePath).toLowerCase();
		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
		fs.createReadStream(filePath).pipe(res);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

// Playwright's bundled browser version may not match what's installed; detect
// any available Chromium build under the standard ms-playwright cache.
const PLAYWRIGHT_DIR = path.join(
	process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
	"ms-playwright",
);
function findChromiumExecutable() {
	let dirs = [];
	try {
		dirs = fs.readdirSync(PLAYWRIGHT_DIR).filter((d) => d.startsWith("chromium-"));
	} catch (_e) {
		/* ignore */
	}
	dirs.sort().reverse(); // newest first
	for (const d of dirs) {
		const candidate = path.join(PLAYWRIGHT_DIR, d, "chrome-win64", "chrome.exe");
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
	const failures = [];

	function check(name, cond) {
		if (!cond) failures.push(name);
		console.log(`  ${cond ? "ok" : "FAIL"}  ${name}`);
	}

	const browser = await chromium.launch(findChromiumExecutable() ? { executablePath: findChromiumExecutable() } : {});
	try {
		const page = await browser.newPage();

		// Stub all /api/* endpoints.
		await page.route("**/api/**", (route) => {
			const url = route.request().url();
			const method = route.request().method();
			if (url.includes("/api/models")) {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						models: [{ name: "test.gguf", relative: "test.gguf", size: 123456, mtime: 1 }],
					}),
				});
			}
			if (url.includes("/api/status")) {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ installed: true, version: "smoke", backend: "cpu-avx2" }),
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
				const body = running
					? {
							state: "running",
							job_id: "smoke_job",
							mode: "img_gen",
							step: 5,
							total_steps: 20,
							percent: 25,
							preview_mtime: 1000 + statusCalls,
							message: "Step 5/20",
						}
					: {
							state: "done",
							job_id: "smoke_job",
							mode: "img_gen",
							step: 20,
							total_steps: 20,
							percent: 100,
							result_files: ["smoke.png"],
							prompt: "a cat",
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

		await page.goto(base, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => !!(window.SDGui && window.SDGui.generateUi && window.SDGui.flagCore));

		// 1. Flag definitions validate.
		const validation = await page.evaluate(() => window.SDGui.validateFlagDefinitions());
		check("flag definitions validate cleanly", validation.ok);
		if (!validation.ok) console.log("    warnings:", validation.warnings);

		// 2. flagCore.getLaunchArgs builds args including the model.
		const setModel = await page.evaluate(() => {
			window.SDGui.flagCore.setFlagValue("model", "test.gguf");
			window.SDGui.flagCore.setFlagValue("prompt", "a cat");
			return window.SDGui.flagCore.getLaunchArgs();
		});
		const flatArgs = (setModel.args || []).map((p) => p.join("=")).join(" ");
		check("getLaunchArgs emits the model flag", flatArgs.includes("--model=test.gguf"));
		check("getLaunchArgs emits the prompt", flatArgs.includes("--prompt=a cat"));
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

		// 4. Pick a model via the Generate picker so generate() has a model.
		await page.selectOption("#gen-model-bundle", "sd1");
		await page.waitForTimeout(150);
		// Explicitly guarantee the model + prompt are in shared state.
		await page.evaluate(() => {
			window.SDGui.flagCore.setFlagValue("model", "test.gguf");
			window.SDGui.flagCore.setFlagValue("prompt", "a cat");
		});
		await page.fill("#gen-prompt", "a cat");

		// 5. Click Generate -> posts + polls.
		await page.click("#btn-generate");
		try {
			await page.waitForFunction(
				() => {
					const img = document.getElementById("gen-preview");
					return img && !img.hidden && img.src.includes("/api/generate/preview");
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

		const historyCount = await page.evaluate(
			() => document.querySelectorAll("#gen-history .history-item").length,
		);
		check("history entry written on done", historyCount >= 1);

		// 7. POST body included mode + args + total_steps.
		check("Generate POST included mode img_gen", generatePosted && generatePosted.mode === "img_gen");
		check("Generate POST included args array", !!(generatePosted && Array.isArray(generatePosted.args)));
		check(
			"Generate POST included total_steps",
			generatePosted && Number.isInteger(generatePosted.total_steps),
		);

		// 8. No uncaught page errors.
		check("no uncaught page errors", errors.length === 0);
		if (errors.length) console.log("    page errors:", errors);

		// 9. History persisted to localStorage.
		const stored = await page.evaluate(() => localStorage.getItem("sdgui.generate.history"));
		check("history persisted to localStorage", !!stored && stored.includes("a cat"));
	} finally {
		await browser.close();
		server.close();
	}

	console.log(`\n${failures.length === 0 ? "ALL SMOKE CHECKS PASSED" : failures.length + " CHECK(S) FAILED"}`);
	if (failures.length) {
		failures.forEach((f) => console.log("  - " + f));
		process.exit(1);
	}
})().catch((err) => {
	console.error("smoke test crashed:", err);
	process.exit(1);
});
