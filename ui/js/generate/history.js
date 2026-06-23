// History storage + UI for the Generate tab (localStorage-backed).
// Owns: loadHistory, saveHistory, historyFileName, addHistoryEntry,
// renderHistory, restoreFromHistory, openHistoryImage,
// removeHistoryEntry, clearHistory, and the clear/more toolbar wiring.
//
// Persistence schema (backward-compatible):
//   {
//     id, name, file, prompt, thumb, timestamp, bundle, mode, params
//   }
// Older entries may only have `name`; `historyFileName()` falls back to
// `name` so existing on-disk files still restore / open / delete.
//
// Cross-module actions (`sendToImg2img`, `downloadResult`, `openResultFile`,
// `syncFromState`, `switchToModeSection`) are injected through `init()` so
// this module never reaches back into the coordinator's closure. They
// preview/results now own the live result actions, and the run controller
// owns the generation lifecycle.
//
// All state reads/writes go through the injected `flagCore` (PLAN.md §8
// sync rule). Safe DOM only (no innerHTML) per AGENTS.md frontend pitfall.
window.SDGui = window.SDGui || {};

window.SDGui.generateHistory = (() => {
	var dom = window.SDGui.generateDom;
	var fmt = window.SDGui.generateFormatters;
	var $ = dom.$;

	var HISTORY_KEY = "sdgui.generate.history";
	var HISTORY_STORE_CAP = 60;
	var HISTORY_VISIBLE_DEFAULT = 20;
	var historyExpanded = false;
	var modeFilter = null;

	// Injected by init(). All flagCore reads/writes go through this — the
	// module never calls `window.SDGui.flagCore` directly except as a
	// late-bound fallback (so the module is testable in isolation).
	var flagCore = null;
	// Coordinator-owned actions wired in via init() so this module never
	// reaches back into the coordinator closure. `sendToImg2img(name)`,
	// `downloadResult(name)`, `openResultFile()` are reused from the live
	// result frame; `syncFromState(renderFields)` and
	// `switchToModeSection(mode)` are needed to fully restore a history
	// entry's mode + flags + bundle re-render.
	var sendToImg2img = function () {};
	var downloadResult = function () {};
	var openResultFile = function () {};
	var syncFromState = function () {};
	var switchToModeSection = function () {};

	function loadHistory() {
		try {
			var raw = localStorage.getItem(HISTORY_KEY);
			var arr = raw ? JSON.parse(raw) : [];
			return Array.isArray(arr) ? arr : [];
		} catch (e) {
			return [];
		}
	}

	function saveHistory(entries) {
		try {
			localStorage.setItem(
				HISTORY_KEY,
				JSON.stringify(entries.slice(0, HISTORY_STORE_CAP)),
			);
		} catch (e) {
			/* quota - ignore */
		}
	}

	// Resolve the on-disk filename for a history entry. Newer entries store
	// `file` (always the real filename with extension); older ones only have
	// `name`, which may be a base_name without extension.
	function historyFileName(entry) {
		if (!entry) return "";
		return entry.file || entry.name || "";
	}

	function matchesModeFilter(entry) {
		if (!modeFilter || !modeFilter.length) return true;
		var mode = entry && entry.mode ? entry.mode : "img_gen";
		return modeFilter.indexOf(mode) !== -1;
	}

	function setModeFilter(modes) {
		modeFilter = Array.isArray(modes) ? modes.slice() : null;
		historyExpanded = false;
		render();
	}

	function addHistoryEntry(snap, file) {
		var fc = flagCore || window.SDGui.flagCore;
		var vals = fc.getFlagValues();
		var ts = Date.now();
		var entry = {
			id: ts + "-" + Math.random().toString(36).slice(2, 8),
			name: snap.job_id || file,
			file: file, // real on-disk filename (with extension) — used by toolbar actions
			prompt: vals.prompt || "",
			thumb: "/api/image/" + encodeURIComponent(file) + "/thumbnail",
			timestamp: ts,
			bundle: fc.getBundle(),
			mode: snap.mode || fc.getMode(),
			params: vals,
		};
		var entries = loadHistory();
		entries.unshift(entry);
		saveHistory(entries);
		render();
	}

	function render() {
		var all = loadHistory();
		var filtered = all.filter(matchesModeFilter);
		var total = filtered.length;
		var shown = historyExpanded
			? total
			: Math.min(total, HISTORY_VISIBLE_DEFAULT);
		var entries = filtered.slice(0, shown);

		// Header count badge.
		var countEl = $("gen-history-count");
		if (countEl) countEl.textContent = String(total);

		// Clear button is only meaningful when there's something to clear.
		var clearBtn = $("btn-clear-history");
		if (clearBtn) clearBtn.classList.toggle("hidden", total === 0);

		// "Show all" toggle: visible only when more exist than the default page.
		var moreBtn = $("btn-history-more");
		if (moreBtn) {
			var hidden = total <= HISTORY_VISIBLE_DEFAULT;
			moreBtn.classList.toggle("hidden", hidden);
			moreBtn.textContent = historyExpanded
				? "Show fewer"
				: "Show all " +
					total +
					" (" +
					(total - HISTORY_VISIBLE_DEFAULT) +
					" more)";
		}

		window.SDGui.gallery.renderHistoryGrid(
			$("gen-history"),
			entries,
			{
				onRestore: restoreFromHistory,
				onSend: (entry) => {
					sendToImg2img(historyFileName(entry));
				},
				onOpen: openHistoryImage,
				onDelete: removeHistoryEntry,
			},
			{ timeLabel: fmt.relativeTime },
		);
	}

	function restoreFromHistory(entry) {
		if (!entry || !entry.params) return;
		var fc = flagCore || window.SDGui.flagCore;
		// Order matters: setMode first (saves the current prompt for the old
		// mode and swaps in the target mode's saved prompt), THEN overwrite
		// with the history entry's params. Doing setMultipleFlagValues before
		// setMode would let setMode's restorePromptForMode clobber the restored
		// prompt — matching applyPreset's (setMode-first) ordering.
		if (entry.mode) fc.setMode(entry.mode);
		if (entry.bundle) fc.setBundle(entry.bundle);
		fc.setMultipleFlagValues(entry.params);
		if (entry.mode) switchToModeSection(entry.mode);
		syncFromState(true);
		window.SDGui.toast("Restored settings from history.", "info");
	}

	// View a history image at full size in the result frame.
	function openHistoryImage(entry) {
		var name = historyFileName(entry);
		if (!name) return;
		window.SDGui.gallery.renderResultImage(
			$("gen-result"),
			name,
			entry.prompt || "result",
			Date.now(),
		);
		var actions = $("gen-result-actions");
		var entryIsVideo = window.SDGui.gallery.isVideoFile(historyFileName(entry));
		if (actions) {
			actions.classList.remove("hidden");
			var openBtn = $("btn-open-result");
			var sendBtn = $("btn-send-img2img");
			var dlBtn = $("btn-download-result");
			if (openBtn) openBtn.onclick = () => openResultFile();
			if (sendBtn) {
				sendBtn.classList.toggle("hidden", entryIsVideo);
				if (!entryIsVideo) sendBtn.onclick = () => sendToImg2img(name);
			}
			if (dlBtn) dlBtn.onclick = () => downloadResult(name);
		}
		if (entry.prompt) {
			window.SDGui.toast("Viewing history image.", "info");
		}
	}

	// Remove a single entry by id (output file on disk is untouched).
	function removeHistoryEntry(entry) {
		if (!entry) return;
		var id = entry.id;
		var entries = loadHistory().filter((e) => e.id !== id);
		saveHistory(entries);
		render();
	}

	// Clear the whole list (output files on disk are untouched).
	async function clearHistory() {
		var ok = await window.SDGui.confirmAction(
			"Clear history?",
			"This removes visible entries from the history list. The output image files on disk are not deleted.",
			"Clear history",
		);
		if (!ok) return;
		try {
			if (modeFilter && modeFilter.length) {
				var remaining = loadHistory().filter((entry) => !matchesModeFilter(entry));
				if (remaining.length) saveHistory(remaining);
				else localStorage.removeItem(HISTORY_KEY);
			} else {
				localStorage.removeItem(HISTORY_KEY);
			}
		} catch (e) {
			/* ignore */
		}
		historyExpanded = false;
		render();
		window.SDGui.toast("History cleared.", "success");
	}

	// Wire up the header toolbar (clear-all + show-more) so the coordinator
	// doesn't need to touch history-specific DOM ids.
	function attachToolbar() {
		var clearBtn = $("btn-clear-history");
		if (clearBtn) clearBtn.addEventListener("click", () => clearHistory());
		var moreBtn = $("btn-history-more");
		if (moreBtn)
			moreBtn.addEventListener("click", () => {
				historyExpanded = !historyExpanded;
				render();
			});
	}

	function init(options) {
		options = options || {};
		flagCore = options.flagCore || window.SDGui.flagCore;
		if (typeof options.sendToImg2img === "function") {
			sendToImg2img = options.sendToImg2img;
		}
		if (typeof options.downloadResult === "function") {
			downloadResult = options.downloadResult;
		}
		if (typeof options.openResultFile === "function") {
			openResultFile = options.openResultFile;
		}
		if (typeof options.syncFromState === "function") {
			syncFromState = options.syncFromState;
		}
		if (typeof options.switchToModeSection === "function") {
			switchToModeSection = options.switchToModeSection;
		}
	}

	return {
		init: init,
		// Coordinator calls this from init() (after the model-fields render
		// has run) and after every `addHistoryEntry`. Re-exported on
		// window.SDGui.generateUi.renderHistory for any external callers
		// (preserves the public surface from before extraction).
		render: render,
		// Coordinator calls this from init() to wire the clear-confirm +
		// show-more toolbar buttons to clearHistory() and the local
		// `historyExpanded` toggle. Kept on the module so the toolbar
		// stays a single DOM contract owned by history concerns.
		attachToolbar: attachToolbar,
		setModeFilter: setModeFilter,
		// Called from the run-controller/result path once per result file.
		addHistoryEntry: addHistoryEntry,
	};
})();
