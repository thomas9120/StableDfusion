// Hugging Face downloader UI (Phase 3).
//
// Flow:
//   1. Enter repo id (e.g. "city96/FLUX.1-schnell-gguf"), optional revision
//      + token. Click "Find Files" → POST /api/hf/repo-files → file list
//      with sizes, filtered server-side to SD-component extensions.
//   2. Multi-select via checkboxes (or "Select all" / "Clear" buttons).
//      "Select all" intelligently only toggles files > 0 size by default
//      (since some repos ship both GGUF and SafeTensors variants and most
//      users want exactly one full bundle).
//   3. "Download to models/" → POST /api/hf/download → background thread
//      streams each file into models/ with progress polling.
//   4. Cancel button sets the cancellation flag; the worker stops after the
//      current chunk and reports "canceled".
//   5. On completion, we ask the Generate tab to refresh its model pickers
//      so the newly downloaded files appear immediately.
//
// All DOM is constructed safely (no innerHTML).
window.SDGui = window.SDGui || {};

window.SDGui.hfDownloadUi = (() => {
	var state = {
		files: [], // [{name, size}]
		selected: new Set(), // filenames currently checked
		pollTimer: null,
		downloading: false,
		lastStatus: null,
	};

	function $(id) {
		return document.getElementById(id);
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function fmtSize(bytes) {
		if (!bytes || bytes <= 0) return "";
		var units = ["B", "KB", "MB", "GB", "TB"];
		var v = bytes;
		var i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
	}

	function setStatus(message, level) {
		var box = $("hf-status");
		if (!box) return;
		box.className = "status-box";
		if (!message) {
			box.textContent = "";
			return;
		}
		box.classList.add(level || "info");
		box.textContent = message;
	}

	function updateSelectionSummary() {
		var sum = $("hf-selection-summary");
		if (sum) {
			var n = state.selected.size;
			sum.textContent =
				n === 0
					? "0 files selected"
					: n === 1
						? "1 file selected"
						: n + " files selected";
		}
		var btn = $("btn-hf-download");
		if (btn) btn.disabled = state.downloading || state.selected.size === 0;
	}

	function renderFileList() {
		var list = $("hf-file-list");
		if (!list) return;
		list.replaceChildren();
		if (!state.files.length) {
			list.appendChild(el("div", "empty", "No files loaded. Enter a repo and click Find Files."));
			updateSelectionSummary();
			return;
		}
		state.files.forEach((file) => {
			var row = el("div", "hf-file-row");
			if (state.selected.has(file.name)) row.classList.add("is-selected");

			var cb = el("input");
			cb.type = "checkbox";
			cb.className = "hf-file-check";
			cb.checked = state.selected.has(file.name);
			cb.addEventListener("change", () => {
				if (cb.checked) state.selected.add(file.name);
				else state.selected.delete(file.name);
				row.classList.toggle("is-selected", cb.checked);
				updateSelectionSummary();
			});

			var name = el("span", "hf-file-name", file.name);
			var size = el("span", "hf-file-size", fmtSize(file.size));

			row.appendChild(cb);
			row.appendChild(name);
			row.appendChild(size);
			list.appendChild(row);
		});
		updateSelectionSummary();
	}

	function readInputs() {
		var repoId = (($("hf-repo-id") || {}).value || "").trim();
		var revision = (($("hf-revision") || {}).value || "").trim();
		var token = (($("hf-token") || {}).value || "").trim();
		return { repo_id: repoId, revision: revision, token: token };
	}

	async function fetchFiles() {
		var inputs = readInputs();
		if (!inputs.repo_id) {
			setStatus("Enter a repository id first.", "warning");
			return;
		}
		setStatus("Fetching file list from Hugging Face…", "info");
		var btn = $("btn-hf-fetch");
		if (btn) btn.disabled = true;
		try {
			var data = await window.SDGui.fetchJson("/api/hf/repo-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(inputs),
			});
			state.files = (data && data.files) || [];
			// Sensible default selection: pre-check the largest of each name
			// family (helps when a repo ships both GGUF + SafeTensors variants —
			// user can override). Skip if there are ≤ 3 files.
			state.selected = new Set();
			if (state.files.length > 0 && state.files.length <= 3) {
				state.files.forEach((f) => state.selected.add(f.name));
			} else if (state.files.length > 3) {
				// Default-select files matching common "main" quant suffixes.
				state.files.forEach((f) => {
					if (/(q4_0|q5_0|q5_1|q8_0|fp8|fp16|f16|safetensors)/i.test(f.name)) {
						state.selected.add(f.name);
					}
				});
			}
			renderFileList();
			var msg =
				"Found " +
				state.files.length +
				" file(s)" +
				(data && data.total_size ? " (" + fmtSize(data.total_size) + " total)" : "") +
				".";
			setStatus(msg, "success");
		} catch (e) {
			state.files = [];
			state.selected = new Set();
			renderFileList();
			setStatus(e.message || "Failed to fetch file list.", "error");
		} finally {
			if (btn) btn.disabled = false;
		}
	}

	async function startDownload() {
		if (state.downloading) return;
		if (state.selected.size === 0) {
			setStatus("Select at least one file to download.", "warning");
			return;
		}
		var inputs = readInputs();
		inputs.files = Array.from(state.selected);
		setStatus("Starting download…", "info");
		setDownloading(true);
		showProgress(true, 0, 0);
		try {
			var result = await window.SDGui.fetchJson("/api/hf/download", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(inputs),
			});
			if (result && result.error) {
				setStatus(result.error, "error");
				setDownloading(false);
				return;
			}
			startPolling();
		} catch (e) {
			setStatus(e.message || "Failed to start download.", "error");
			setDownloading(false);
			showProgress(false);
		}
	}

	async function cancelDownload() {
		try {
			await window.SDGui.fetchJson("/api/hf/download-cancel", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		} catch (e) {
			setStatus(e.message || "Failed to cancel.", "error");
		}
	}

	function setDownloading(on) {
		state.downloading = on;
		var downloadBtn = $("btn-hf-download");
		var cancelBtn = $("btn-hf-cancel");
		var fetchBtn = $("btn-hf-fetch");
		if (downloadBtn) downloadBtn.classList.toggle("hidden", on);
		if (cancelBtn) cancelBtn.classList.toggle("hidden", !on);
		if (fetchBtn) fetchBtn.disabled = on;
		updateSelectionSummary();
	}

	function showProgress(show, downloaded, total) {
		var box = $("hf-progress");
		var fill = $("hf-progress-fill");
		var text = $("hf-progress-text");
		if (!box || !fill || !text) return;
		if (!show) {
			box.classList.add("hidden");
			return;
		}
		box.classList.remove("hidden");
		var pct = total > 0 ? Math.min(100, (downloaded * 100) / total) : 0;
		fill.style.width = pct.toFixed(1) + "%";
		text.textContent =
			total > 0
				? pct.toFixed(1) + "%  (" + fmtSize(downloaded) + " / " + fmtSize(total) + ")"
				: downloaded > 0
					? fmtSize(downloaded)
					: "Starting…";
	}

	async function pollStatus() {
		try {
			var snap = await window.SDGui.fetchJson("/api/hf/download-status");
			state.lastStatus = snap;
			var status = snap.status || "idle";
			if (status === "downloading" || status === "starting") {
				showProgress(
					true,
					Number(snap.downloaded) || 0,
					Number(snap.total) || 0,
				);
				setStatus(
					(snap.message || status) +
						(snap.current_file ? " — " + snap.current_file : ""),
					"info",
				);
				return;
			}
			// Terminal state.
			stopPolling();
			setDownloading(false);
			if (status === "done") {
				showProgress(true, 1, 1); // full bar
				setStatus(snap.message || "Download complete.", "success");
				window.SDGui.toast("HF download complete.", "success");
				notifyGenerateTab();
				// Clear partial selection once finished.
				state.selected = new Set();
				renderFileList();
			} else if (status === "canceled") {
				showProgress(false);
				setStatus(snap.message || "Download canceled.", "warning");
				window.SDGui.toast("HF download canceled.", "warning");
			} else if (status === "error") {
				showProgress(false);
				setStatus(snap.message || "Download failed.", "error");
				window.SDGui.toast(snap.message || "HF download failed.", "error");
			} else {
				showProgress(false);
			}
		} catch (e) {
			/* transient — keep polling */
		}
	}

	function startPolling() {
		stopPolling();
		state.pollTimer = setInterval(pollStatus, 500);
	}

	function stopPolling() {
		if (state.pollTimer) {
			clearInterval(state.pollTimer);
			state.pollTimer = null;
		}
	}

	function notifyGenerateTab() {
		// Re-render the Generate tab's bundle-driven model pickers so the
		// newly-downloaded files appear in the dropdowns immediately.
		try {
			if (
				window.SDGui.generateUi &&
				typeof window.SDGui.generateUi.renderBundleFields === "function"
			) {
				window.SDGui.generateUi.renderBundleFields();
			}
		} catch (e) {
			console.warn("Could not refresh Generate tab pickers:", e);
		}
	}

	function selectAll() {
		state.selected = new Set(state.files.map((f) => f.name));
		renderFileList();
	}

	function selectNone() {
		state.selected = new Set();
		renderFileList();
	}

	function init() {
		// Buttons.
		var fetchBtn = $("btn-hf-fetch");
		if (fetchBtn) fetchBtn.addEventListener("click", fetchFiles);
		var dlBtn = $("btn-hf-download");
		if (dlBtn) dlBtn.addEventListener("click", startDownload);
		var cancelBtn = $("btn-hf-cancel");
		if (cancelBtn) cancelBtn.addEventListener("click", cancelDownload);
		var selAllBtn = $("btn-hf-select-all");
		if (selAllBtn) selAllBtn.addEventListener("click", selectAll);
		var selNoneBtn = $("btn-hf-select-none");
		if (selNoneBtn) selNoneBtn.addEventListener("click", selectNone);

		// Pressing Enter in the repo-id field triggers Find Files.
		var repoInput = $("hf-repo-id");
		if (repoInput)
			repoInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					fetchFiles();
				}
			});

		updateSelectionSummary();

		// If a download is in progress (page reload), resume polling.
		window.SDGui.fetchJson("/api/hf/download-status")
			.then((snap) => {
				if (snap && (snap.status === "downloading" || snap.status === "starting")) {
					setDownloading(true);
					showProgress(
						true,
						Number(snap.downloaded) || 0,
						Number(snap.total) || 0,
					);
					startPolling();
				}
			})
			.catch(() => {});
	}

	return { init: init, fetchFiles: fetchFiles };
})();
