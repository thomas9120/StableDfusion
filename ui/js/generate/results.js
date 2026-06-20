// Result-frame rendering + result file actions for the Generate tab.
// Owns: renderResult, renderResultError, downloadResult, openResultFile, and
// result action wiring. Safe DOM only (no innerHTML).
window.SDGui = window.SDGui || {};

window.SDGui.generateResults = (() => {
	var dom = window.SDGui.generateDom;
	var $ = dom.$;
	var el = dom.el;

	var flagCore = null;
	var history = null;
	var previewProgress = null;
	var sendToImg2img = function () {};

	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
		history = options.history || window.SDGui.generateHistory;
		previewProgress =
			options.previewProgress || window.SDGui.generatePreviewProgress;
		if (typeof options.sendToImg2img === "function") {
			sendToImg2img = options.sendToImg2img;
		}
	}

	function getMode() {
		var fc = flagCore || window.SDGui.flagCore;
		return fc ? fc.getMode() : "img_gen";
	}

	// A10 - copy-to-clipboard was REMOVED: the Web Clipboard API only
	// carries image *pixel data*, never a file reference, so pasting into a
	// folder (the obvious intent) is impossible by browser design — and
	// Download + Show-in-folder cover every file-management case. Do not
	// re-add without a different mechanism.

	function addResultToHistory(snap) {
		if (!history || typeof history.addHistoryEntry !== "function") return;
		var files = snap.result_files || [];
		var mode = snap.mode || getMode();
		if (mode === "metadata") {
			history.addHistoryEntry(snap, files[0] || "metadata");
			return;
		}
		files.forEach((f) => history.addHistoryEntry(snap, f));
	}

	function renderResult(snap, options) {
		options = options || {};
		var box = $("gen-result");
		var actions = $("gen-result-actions");
		if (!box) return;
		box.replaceChildren();
		box.classList.remove("is-error");

		// Show any generation warnings (small output, suspicious files, etc.).
		var wrn = snap.warnings || [];
		if (wrn.length) {
			var warnDiv = el("div", "gen-warnings");
			wrn.forEach((w) => {
				warnDiv.appendChild(el("div", "gen-warning-msg", "⚠ " + w));
			});
			box.appendChild(warnDiv);
		}

		// Show stderr tail (sd-cli diagnostics) when available.
		var stderrTail = (snap.stderr_tail || "").toString().trim();
		if (stderrTail) {
			var details = el("details", "gen-stderr");
			var summary = el("summary", "", "sd-cli diagnostic output (stderr)");
			details.appendChild(summary);
			var pre = el("pre", "gen-stderr-text");
			pre.textContent = stderrTail;
			details.appendChild(pre);
			box.appendChild(details);
		}

		var files = snap.result_files || [];
		var mode = snap.mode || getMode();

		// Metadata mode: no image file is produced - sd-cli prints the metadata
		// to stdout. Render the text into the result box.
		if (mode === "metadata") {
			var text = (snap.stdout_excerpt || "").toString();
			if (!text) {
				box.appendChild(
					el(
						"div",
						"help-text",
						"No metadata output captured (the image may have no embedded metadata).",
					),
				);
			} else {
				var pre = el("pre", "result-text");
				pre.textContent = text;
				box.appendChild(pre);
			}
			if (actions) actions.classList.add("hidden");
			if (!options.skipHistory) addResultToHistory(snap);
			return;
		}

		if (!files.length) {
			previewProgress.showResultEmpty("No image was produced.");
			if (actions) actions.classList.add("hidden");
			return;
		}
		// A2 - batch results: show a gallery when more than one file.
		if (files.length > 1) {
			window.SDGui.gallery.renderResultGallery(
				box,
				files,
				snap.prompt || "result",
				Date.now(),
			);
		} else {
			window.SDGui.gallery.renderResultImage(
				box,
				files[0],
				snap.prompt || "result",
				Date.now(),
			);
		}
		var first = files[0];
		var firstIsVideo = window.SDGui.gallery.isVideoFile(first);
		if (actions) {
			actions.classList.remove("hidden");
			var openBtn = $("btn-open-result");
			var sendBtn = $("btn-send-img2img");
			var dlBtn = $("btn-download-result");
			if (openBtn) openBtn.onclick = () => openResultFile();
			// "Send to img2img" only applies to images; hide it for video results.
			if (sendBtn) {
				sendBtn.classList.toggle("hidden", firstIsVideo);
				if (!firstIsVideo) sendBtn.onclick = () => sendToImg2img(first);
			}
			if (dlBtn) dlBtn.onclick = () => downloadResult(first);
		}
		// Add to history (one entry per result file for batch).
		if (!options.skipHistory) addResultToHistory(snap);
	}

	// A9 - render an inline error in the result frame (instead of toast-only).
	function renderResultError(snap) {
		var box = $("gen-result");
		var actions = $("gen-result-actions");
		if (actions) actions.classList.add("hidden");
		if (!box) return;
		box.replaceChildren();
		box.classList.add("is-error");
		var msg = el(
			"div",
			"gen-error",
			"✗ " + (snap.error || "Generation failed."),
		);
		box.appendChild(msg);
		var stderrTail = (snap.stderr_tail || "").toString().trim();
		if (stderrTail) {
			var details = el("details", "gen-stderr");
			details.appendChild(
				el("summary", "", "sd-cli diagnostic output (stderr)"),
			);
			var pre = el("pre", "gen-stderr-text");
			pre.textContent = stderrTail;
			details.appendChild(pre);
			box.appendChild(details);
		}
	}

	function downloadResult(name) {
		if (!name) return;
		var a = el("a");
		a.href = "/api/image/" + encodeURIComponent(name) + "?download=1";
		a.download = String(name).split("/").pop() || "result";
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function openResultFile() {
		window.SDGui.fetchJson("/api/open-folder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder: "output" }),
		}).catch((e) => window.SDGui.toast(e.message, "error"));
	}

	return {
		init: init,
		renderResult: renderResult,
		renderResultError: renderResultError,
		addResultToHistory: addResultToHistory,
		downloadResult: downloadResult,
		openResultFile: openResultFile,
	};
})();
