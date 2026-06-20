// Pure formatting helpers used by the Generate tab.
// No DOM, no state, no flagCore access — easy to test in isolation.
window.SDGui = window.SDGui || {};

window.SDGui.generateFormatters = (() => {
	// A11 - elapsed time formatter for progress + ETA ("5s" / "1m 12s").
	function formatElapsed(ms) {
		var s = Math.max(0, Math.floor(ms / 1000));
		if (s < 60) return s + "s";
		return Math.floor(s / 60) + "m " + (s % 60) + "s";
	}

	// Relative "2h ago" label for a timestamp (ms). Returns '' when unknown.
	function relativeTime(ts) {
		if (!ts) return "";
		var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
		if (s < 45) return "just now";
		if (s < 90) return "1m ago";
		var m = Math.round(s / 60);
		if (m < 60) return m + "m ago";
		var h = Math.round(m / 60);
		if (h < 24) return h + "h ago";
		var d = Math.round(h / 24);
		if (d < 7) return d + "d ago";
		return new Date(ts).toLocaleDateString();
	}

	// LoRA helpers: path → name for prompt-injection; path → folder for
	// --lora-model-dir. Both are used in render + at generation time.
	function loraNameFromPath(value) {
		var text = String(value || "").replace(/\\/g, "/");
		var name = text.split("/").pop() || "";
		return name.replace(/\.(safetensors|ckpt|gguf|sft|bin)$/i, "");
	}

	function loraFolderFromPath(value) {
		var text = String(value || "").replace(/\\/g, "/");
		var idx = text.lastIndexOf("/");
		if (idx <= 0) return "models/loras";
		return text.slice(0, idx);
	}

	// Round a strength to 2 decimals ("1", "0.75", "-0.5"). Used for the
	// <lora:name:strength> tag and the slider value label.
	function formatLoraStrength(value) {
		var n = Number(value);
		if (!Number.isFinite(n)) n = 1;
		return String(Math.round(n * 100) / 100);
	}

	return {
		formatElapsed: formatElapsed,
		relativeTime: relativeTime,
		loraNameFromPath: loraNameFromPath,
		loraFolderFromPath: loraFolderFromPath,
		formatLoraStrength: formatLoraStrength,
	};
})();
