// Live preview + progress rendering for the Generate tab.
// Owns preview media switching (image vs video), progress bar text/fill, and
// empty result-frame placeholders. Safe DOM only (no innerHTML).
window.SDGui = window.SDGui || {};

window.SDGui.generatePreviewProgress = (() => {
	var dom = window.SDGui.generateDom;
	var fmt = window.SDGui.generateFormatters;
	var $ = dom.$;
	var el = dom.el;

	var flagCore = null;
	var runStartTime = 0;

	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
	}

	function setRunStartTime(value) {
		runStartTime = value || 0;
	}

	function getMode() {
		var fc = flagCore || window.SDGui.flagCore;
		return fc ? fc.getMode() : "img_gen";
	}

	function showProgressBar(visible, indeterminate) {
		var bar = $("gen-progress");
		if (!bar) return;
		bar.classList.toggle("hidden", !visible);
		bar.classList.toggle("indeterminate", !!indeterminate);
	}

	function setProgressFill(percent) {
		var fill = $("gen-progress-fill");
		if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
	}

	// vid_gen previews are multi-frame .webm files (sd-cli writes
	// .avi/.webm/.webp previews), so render them in a <video> instead of the
	// shared <img>. The <video> is created lazily inside the preview frame and
	// only used on the Generate Video tab; image modes keep using <img>.
	function ensurePreviewVideo() {
		var frame = $("gen-preview-frame");
		if (!frame) return null;
		var v = $("gen-preview-video");
		if (!v) {
			v = el("video", "preview-video");
			v.id = "gen-preview-video";
			v.controls = true;
			v.muted = true;
			v.playsInline = true;
			v.hidden = true;
			frame.insertBefore(v, $("gen-preview-empty") || null);
		}
		return v;
	}

	// Returns the active preview media element for the current mode, hiding the
	// inactive one so only one of <img>/<video> is visible at a time.
	function activePreviewMedia() {
		if (getMode() === "vid_gen") {
			var img = $("gen-preview");
			if (img) img.hidden = true;
			return ensurePreviewVideo();
		}
		var v = $("gen-preview-video");
		if (v) v.hidden = true;
		return $("gen-preview");
	}

	function resetPreview() {
		var img = $("gen-preview");
		if (img) {
			img.hidden = true;
			img.removeAttribute("src");
		}
		var v = $("gen-preview-video");
		if (v) {
			v.hidden = true;
			v.removeAttribute("src");
		}
		var previewEmpty = $("gen-preview-empty");
		if (previewEmpty) previewEmpty.style.display = "";
	}

	function refreshPreview(mtime) {
		var media = activePreviewMedia();
		var empty = $("gen-preview-empty");
		if (!media) return;
		media.src = "/api/generate/preview?t=" + mtime;
		media.hidden = false;
		// Live video preview: muted autoplay so the denoising preview animates.
		if (media.tagName === "VIDEO" && typeof media.play === "function") {
			media.play().catch(() => {});
		}
		if (empty) empty.style.display = "none";
	}

	function updateProgress(snap) {
		var text = $("gen-progress-text");
		var pct = $("gen-progress-pct");
		var running = snap.state === "running";
		showProgressBar(running || snap.state === "queued", !snap.total_steps);

		if (running && snap.total_steps) {
			setProgressFill(snap.percent || 0);
			var started = snap.started_at ? snap.started_at * 1000 : runStartTime;
			var elapsed = started ? fmt.formatElapsed(Date.now() - started) : "";
			var eta = "";
			if (started && snap.percent > 0) {
				var ms = Date.now() - started;
				var etaMs = (ms / snap.percent) * (100 - snap.percent);
				eta = " · ETA " + fmt.formatElapsed(etaMs);
			}
			if (text)
				text.textContent =
					(snap.message || "Generating...") +
					"  " +
					snap.step +
					"/" +
					snap.total_steps +
					(elapsed ? "  ·  " + elapsed : "");
			if (pct) pct.textContent = (snap.percent || 0) + "%" + eta;
		} else if (running) {
			if (text) text.textContent = snap.message || "Starting...";
			if (pct) pct.textContent = "";
		} else {
			if (text) text.textContent = snap.message || snap.state;
			if (pct) pct.textContent = "";
		}
	}

	function showResultEmpty(message) {
		var box = $("gen-result");
		if (!box) return;
		box.replaceChildren();
		box.classList.remove("is-error");
		var cap = el(
			"div",
			"frame-empty",
			message || "Your generated image will appear here.",
		);
		cap.id = "gen-result-empty";
		box.appendChild(cap);
	}

	return {
		init: init,
		setRunStartTime: setRunStartTime,
		showProgressBar: showProgressBar,
		setProgressFill: setProgressFill,
		resetPreview: resetPreview,
		refreshPreview: refreshPreview,
		updateProgress: updateProgress,
		showResultEmpty: showResultEmpty,
	};
})();
