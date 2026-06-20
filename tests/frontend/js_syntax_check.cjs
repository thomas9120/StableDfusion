// Frontend syntax check: runs `node --check` on every ui/js file.
// Invoke via `npm run test:syntax`.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const jsDir = path.join(root, "ui", "js");

function collectJs(dir) {
	let files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files = files.concat(collectJs(full));
		} else if (entry.name.endsWith(".js")) {
			files.push(full);
		}
	}
	return files;
}

const files = collectJs(jsDir);
let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch (err) {
		failed++;
		console.error(
			`FAIL  ${path.relative(root, file)}\n${err.stderr || err.message}`,
		);
	}
}

const rel = files.map((f) => path.relative(root, f));
console.log(
	`Checked ${files.length} JS file(s): ${files.length - failed} ok, ${failed} failed.`,
);
rel.forEach((f) => console.log(`  ok  ${f}`));
process.exit(failed === 0 ? 0 : 1);
