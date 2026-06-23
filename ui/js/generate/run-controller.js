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
	var pollInFlight = false;

	var flagCore = null;
	var previewProgress = null;
	var results = null;
	var runningSection = null;
	var activeConfig = function () {
		return {
			running: "Generating... your image will appear here.",
		};
	};
	var getActiveSection = function () {
		return "generate-image";
	};
	var sectionForMode = function (mode) {
		return mode === "vid_gen"
			? "generate-video"
			: mode === "upscale"
				? "upscale"
				: mode === "convert"
					? "convert"
					: "generate-image";
	};
	var onRunStart = function () {};
	var onRunProgress = function () {};
	var onRunPreview = function () {};
	var onRunDone = function () {};
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
		if (typeof options.getActiveSection === "function") {
			getActiveSection = options.getActiveSection;
		}
		if (typeof options.sectionForMode === "function") {
			sectionForMode = options.sectionForMode;
		}
		if (typeof options.onRunStart === "function") {
			onRunStart = options.onRunStart;
		}
		if (typeof options.onRunProgress === "function") {
			onRunProgress = options.onRunProgress;
		}
		if (typeof options.onRunPreview === "function") {
			onRunPreview = options.onRunPreview;
		}
		if (typeof options.onRunDone === "function") {
			onRunDone = options.onRunDone;
		}
		if (typeof options.syncFromState === "function") {
			syncFromState = options.syncFromState;
		}
		if (typeof options.updateModeSections === "function") {
			updateModeSections = options.updateModeSections;
		}
	}

	function setGenBtnLabel(text) {
		var btn = $("btn-generate");
		if (!btn) return;
		var label = btn.querySelector(".gen-btn-label");
		if (label) label.textContent = text;
	}

	function setGenBtnBusy(on) {
		var btn = $("btn-generate");
		if (!btn) return;
		var spinner = btn.querySelector(".gen-btn-spinner");
		if (spinner) spinner.hidden = !on;
		btn.classList.toggle("is-generating", !!on);
		if (on) setGenBtnLabel("Generating\u2026");
		else setGenBtnLabel("Generate");
	}

	function updateGenBtnFromSnap(snap) {
		if (!snap || snap.state !== "running") return;
		var pct = snap.percent;
		if (typeof pct === "number" && isFinite(pct) && pct >= 0 && pct <= 100) {
			setGenBtnLabel("Generating\u2026 " + Math.round(pct) + "%");
		}
	}

	function setGenerating(on) {
		generating = on;
		var genBtn = $("btn-generate");
		var cancelBtn = $("btn-generate-cancel");
		if (genBtn) genBtn.disabled = on;
		if (cancelBtn) cancelBtn.classList.toggle("hidden", !on);
		setGenBtnBusy(!!on);
	}

	// M23 — sync the shared generate/cancel buttons to the active section's
	// run state. The workbench is shared across Generate/Video/Upscale/Convert,
	// so switching sections while a job runs in another must not leave the
	// buttons stuck in "generating" for the idle section.
	function syncForActiveSection(section) {
		var isRunningHere = generating && runningSection === section;
		var genBtn = $("btn-generate");
		var cancelBtn = $("btn-generate-cancel");
		if (isRunningHere) {
			if (genBtn) genBtn.disabled = true;
			if (cancelBtn) cancelBtn.classList.remove("hidden");
			setGenBtnBusy(true);
		} else {
			// No job is running in this section (one may be running elsewhere,
			// but its UI belongs to that section's workspace state, not the
			// shared buttons). Show the idle button + hide cancel.
			if (genBtn) genBtn.disabled = false;
			if (cancelBtn) cancelBtn.classList.add("hidden");
			setGenBtnBusy(false);
		}
	}

	async function poll() {
		// M17 — guard against overlapping polls when the status endpoint is
		// slow (setInterval fires every 400ms regardless of in-flight state).
		if (pollInFlight) return;
		pollInFlight = true;
		try {
			var snap = await window.SDGui.fetchJson("/api/generate/status");
			var section = runningSection || sectionForMode(snap.mode || flagCore.getMode());
			onRunProgress(section, snap);
			updateGenBtnFromSnap(snap);
			if (snap.state === "running") {
				if (snap.preview_mtime && snap.preview_mtime !== lastPreviewMtime) {
					lastPreviewMtime = snap.preview_mtime;
					onRunPreview(section, snap.preview_mtime);
				}
				return;
			}
			// Terminal state.
			stopPolling();
			setGenerating(false);
			if (snap.state === "done") {
				previewProgress.setRunStartTime(0);
				previewProgress.showProgressBar(false);
				onRunDone(section, snap);
				if (results && typeof results.addResultToHistory === "function") {
					results.addResultToHistory(snap);
				}
				window.SDGui.toast("Generation complete.", "success");
			} else if (snap.state === "error") {
				previewProgress.setRunStartTime(0);
				previewProgress.showProgressBar(false);
				onRunDone(section, snap);
				window.SDGui.toast(snap.error || "Generation failed.", "error");
			} else if (snap.state === "canceled") {
				previewProgress.setRunStartTime(0);
				previewProgress.showProgressBar(false);
				onRunDone(section, snap);
				window.SDGui.toast("Generation canceled.", "warning");
			}
			runningSection = null;
		} catch (e) {
			/* transient network - keep polling */
		} finally {
			pollInFlight = false;
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

	function looksLikeJson(text) {
		var s = String(text || "").trim();
		if (!s || (s[0] !== "{" && s[0] !== "[")) return false;
		try {
			JSON.parse(s);
			return true;
		} catch (e) {
			return false;
		}
	}

	function selectedLoras(vals) {
		var entries = Array.isArray(vals.lora_files) ? vals.lora_files : [];
		entries = entries
			.map((entry) => ({
				path: String((entry && entry.path) || ""),
				strength:
					entry && entry.strength !== undefined && entry.strength !== ""
						? entry.strength
						: 1,
			}))
			.filter((entry) => entry.path);
		if (!entries.length && vals.lora_file) {
			entries.push({
				path: vals.lora_file,
				strength:
					vals.lora_strength !== undefined && vals.lora_strength !== ""
						? vals.lora_strength
						: 1,
			});
		}
		return entries.slice(0, 5);
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
		var loras = selectedLoras(vals);
		var jsonPrompt = looksLikeJson(vals.prompt);
		if (loras.length && jsonPrompt) {
			window.SDGui.toast("LoRA prompt tags skipped: prompt is JSON.", "warning");
		}
		if (loras.length && !jsonPrompt) {
			var loraTags = loras.map((entry) => {
				return (
					"<lora:" +
					fmt.loraNameFromPath(entry.path) +
					":" +
					fmt.formatLoraStrength(entry.strength) +
					">"
				);
			});
			vals.prompt = ((vals.prompt || "").trim() + " " + loraTags.join(" ")).trim();
			var promptPair = result.args.find(
				(pair) => pair[0] === "--prompt" || pair[0] === "-p",
			);
			if (promptPair) {
				promptPair[1] = vals.prompt;
			} else {
				result.args.push(["--prompt", vals.prompt]);
			}
			var loraDir = vals.lora_model_dir || fmt.loraFolderFromPath(loras[0].path);
			vals.lora_model_dir = loraDir;
			if (!result.args.some((pair) => pair[0] === "--lora-model-dir")) {
				result.args.push(["--lora-model-dir", loraDir]);
			}
			if (!vals.disable_image_metadata) {
				vals.disable_image_metadata = true;
				result.args.push(["--disable-image-metadata"]);
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
		runningSection = sectionForMode(body.mode);

		// Reset preview area (only relevant for img_gen/vid_gen, harmless for others).
		lastPreviewMtime = 0;
		onRunStart(runningSection);
		setGenerating(true);
		if (flagCore && typeof flagCore.persistPrompts === "function") {
			flagCore.persistPrompts();
		}
		previewProgress.setRunStartTime(Date.now());
		if (runningSection === getActiveSection()) {
			previewProgress.showProgressBar(true, true);
			previewProgress.showResultEmpty(activeConfig().running);
			var prog = $("gen-progress-text");
			if (prog) prog.textContent = "Starting...";
		}

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
			onRunDone(runningSection, {
				state: "error",
				mode: body.mode,
				error: e.message,
			});
			runningSection = null;
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
					runningSection = sectionForMode(snap.mode || flagCore.getMode());
					setGenerating(true);
					onRunStart(runningSection);
					startPolling();
				}
			})
			.catch(() => {});
	}

	return {
		init: init,
		setGenerating: setGenerating,
		syncForActiveSection: syncForActiveSection,
		poll: poll,
		startPolling: startPolling,
		stopPolling: stopPolling,
		generate: generate,
		cancel: cancel,
		inspectMetadata: inspectMetadata,
		resumeIfRunning: resumeIfRunning,
	};
})();
