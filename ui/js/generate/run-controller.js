// Generate run lifecycle controller.
// Owns request construction, LoRA prompt injection, polling, cancel, metadata
// inspection, and generate/cancel button state. Safe DOM only (no innerHTML).
window.SDGui = window.SDGui || {};

window.SDGui.generateRunController = (() => {
	var dom = window.SDGui.generateDom;
	var fmt = window.SDGui.generateFormatters;
	var $ = dom.$;

	var pollTimer = null;
	var lastPreviewMtime = 0;
	var generating = false;

	var flagCore = null;
	var previewProgress = null;
	var results = null;
	var activeConfig = function () {
		return {
			running: "Generating... your image will appear here.",
		};
	};
	var syncFromState = function () {};
	var updateModeSections = function () {};

	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
		previewProgress =
			options.previewProgress || window.SDGui.generatePreviewProgress;
		results = options.results || window.SDGui.generateResults;
		if (typeof options.activeConfig === "function") {
			activeConfig = options.activeConfig;
		}
		if (typeof options.syncFromState === "function") {
			syncFromState = options.syncFromState;
		}
		if (typeof options.updateModeSections === "function") {
			updateModeSections = options.updateModeSections;
		}
	}

	function setGenerating(on) {
		generating = on;
		var genBtn = $("btn-generate");
		var cancelBtn = $("btn-generate-cancel");
		if (genBtn) genBtn.disabled = on;
		if (cancelBtn) cancelBtn.classList.toggle("hidden", !on);
	}

	async function poll() {
		try {
			var snap = await window.SDGui.fetchJson("/api/generate/status");
			previewProgress.updateProgress(snap);
			if (snap.state === "running") {
				if (snap.preview_mtime && snap.preview_mtime !== lastPreviewMtime) {
					lastPreviewMtime = snap.preview_mtime;
					previewProgress.refreshPreview(snap.preview_mtime);
				}
				return;
			}
			// Terminal state.
			stopPolling();
			setGenerating(false);
			if (snap.state === "done") {
				previewProgress.setRunStartTime(0);
				previewProgress.showProgressBar(false);
				results.renderResult(snap);
				window.SDGui.toast("Generation complete.", "success");
			} else if (snap.state === "error") {
				previewProgress.setRunStartTime(0);
				previewProgress.showProgressBar(false);
				results.renderResultError(snap);
				window.SDGui.toast(snap.error || "Generation failed.", "error");
			} else if (snap.state === "canceled") {
				previewProgress.setRunStartTime(0);
				previewProgress.showProgressBar(false);
				window.SDGui.toast("Generation canceled.", "warning");
			}
		} catch (e) {
			/* transient network - keep polling */
		}
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function startPolling() {
		stopPolling();
		pollTimer = setInterval(poll, 400);
	}

	async function generate(options) {
		options = options || {};
		if (generating) return;
		var restoreMode = options.restoreMode || null;
		var result = flagCore.getLaunchArgs();
		if (result.error) {
			window.SDGui.toast(result.error, "error");
			if (restoreMode) {
				flagCore.setMode(restoreMode);
				syncFromState(false);
			}
			return;
		}
		(result.warnings || []).forEach((w) => window.SDGui.toast(w, "warning"));

		var vals = Object.assign({}, flagCore.getFlagValues());
		if (vals.lora_file) {
			var loraName = fmt.loraNameFromPath(vals.lora_file);
			var loraStrength = fmt.formatLoraStrength(vals.lora_strength);
			var loraTag = "<lora:" + loraName + ":" + loraStrength + ">";
			vals.prompt = ((vals.prompt || "").trim() + " " + loraTag).trim();
			var promptPair = result.args.find(
				(pair) => pair[0] === "--prompt" || pair[0] === "-p",
			);
			if (promptPair) {
				promptPair[1] = vals.prompt;
			} else {
				result.args.push(["--prompt", vals.prompt]);
			}
			var loraDir = vals.lora_model_dir || fmt.loraFolderFromPath(vals.lora_file);
			vals.lora_model_dir = loraDir;
			if (!result.args.some((pair) => pair[0] === "--lora-model-dir")) {
				result.args.push(["--lora-model-dir", loraDir]);
			}
		}
		var body = {
			mode: flagCore.getMode(),
			bundle: flagCore.getBundle(),
			args: result.args,
			seed: vals.seed,
			total_steps: vals.steps,
			preview_method: vals.preview,
			preview_interval: vals.preview_interval,
			params: vals,
		};

		// Reset preview area (only relevant for img_gen/vid_gen, harmless for others).
		lastPreviewMtime = 0;
		previewProgress.resetPreview();
		// A9 - reset result frame to its empty state on a fresh run.
		previewProgress.showResultEmpty(activeConfig().running);
		setGenerating(true);
		previewProgress.setRunStartTime(Date.now());
		previewProgress.showProgressBar(true, true);
		var prog = $("gen-progress-text");
		if (prog) prog.textContent = "Starting...";

		try {
			await window.SDGui.fetchJson("/api/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (restoreMode) {
				flagCore.setMode(restoreMode);
				syncFromState(false);
			}
			startPolling();
		} catch (e) {
			if (restoreMode) {
				flagCore.setMode(restoreMode);
				syncFromState(false);
			}
			setGenerating(false);
			window.SDGui.toast(e.message, "error");
		}
	}

	function inspectMetadata() {
		var restoreMode = flagCore.getMode();
		flagCore.setMode("metadata");
		updateModeSections();
		generate({
			restoreMode: restoreMode === "metadata" ? "img_gen" : restoreMode,
		});
	}

	async function cancel() {
		try {
			await window.SDGui.fetchJson("/api/generate/cancel", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		} catch (e) {
			window.SDGui.toast(e.message, "error");
		}
	}

	function resumeIfRunning() {
		window.SDGui.fetchJson("/api/generate/status")
			.then((snap) => {
				if (snap && snap.state === "running") {
					setGenerating(true);
					startPolling();
				}
			})
			.catch(() => {});
	}

	return {
		init: init,
		setGenerating: setGenerating,
		poll: poll,
		startPolling: startPolling,
		stopPolling: stopPolling,
		generate: generate,
		cancel: cancel,
		inspectMetadata: inspectMetadata,
		resumeIfRunning: resumeIfRunning,
	};
})();
