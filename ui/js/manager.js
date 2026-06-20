// GitHub releases, install/update/repair/remove, and the shared fetchJson() +
// confirmAction() + toast() utilities. Mirrors LLama-GUI's manager.js, adapted
// to stable-diffusion.cpp (pattern-matched assets, sdcpp/ paths).
window.SDGui = window.SDGui || {};

// Lightweight non-blocking toast. Safe DOM (no innerHTML).
window.SDGui.toast = (message, kind) => {
	var container = document.getElementById("toast-container");
	if (!container) return;
	var note = document.createElement("div");
	note.className = "toast toast-" + (kind || "info");
	note.textContent = String(message || "");
	container.appendChild(note);
	setTimeout(() => {
		note.classList.add("toast-out");
		setTimeout(() => note.remove(), 300);
	}, 3500);
};

// Shared API helper. Throws an Error (with the server's message) on non-OK
// responses, so callers can surface `e.message` directly.
window.SDGui.fetchJson = async (url, options) => {
	var resp = await fetch(url, options);
	var data = null;
	try {
		var text = await resp.text();
		data = text ? JSON.parse(text) : null;
	} catch (e) {
		if (!resp.ok) throw new Error("Request failed (" + resp.status + ")");
		throw new Error("Invalid JSON response from " + url);
	}
	if (!resp.ok) {
		var msg =
			data && data.error ? data.error : "Request failed (" + resp.status + ")";
		throw new Error(msg);
	}
	return data;
};

// Copy text to the clipboard with a toast. Returns true on success.
window.SDGui.copyText = async (text) => {
	try {
		await navigator.clipboard.writeText(String(text == null ? "" : text));
		window.SDGui.toast("Copied to clipboard.", "success");
		return true;
	} catch (e) {
		window.SDGui.toast("Copy failed: " + e.message, "error");
		return false;
	}
};

// Attach an absolutely-positioned "Copy" button to a <pre> (or any element).
// `getText` returns the current text to copy; safe to call on every render.
window.SDGui.attachCopyButton = (pre, getText) => {
	if (!pre) return;
	if (pre.querySelector(".copy-btn")) return;
	var btn = document.createElement("button");
	btn.type = "button";
	btn.className = "btn btn-sm copy-btn";
	btn.textContent = "Copy";
	btn.setAttribute("aria-label", "Copy to clipboard");
	btn.addEventListener("click", () => {
		window.SDGui.copyText(
			typeof getText === "function" ? getText() : pre.textContent,
		);
	});
	pre.appendChild(btn);
};

// Shared confirm dialog (uses #confirm-modal). Returns a Promise<boolean>.
window.SDGui.confirmAction = (title, message, confirmText) => {
	var modal = document.getElementById("confirm-modal");
	var titleEl = document.getElementById("confirm-modal-title");
	var messageEl = document.getElementById("confirm-modal-message");
	var cancelBtn = document.getElementById("confirm-modal-cancel");
	var okBtn = document.getElementById("confirm-modal-ok");
	if (!modal || !okBtn) return Promise.resolve(true);

	titleEl.textContent = title || "Confirm Action";
	messageEl.textContent = message || "Are you sure you want to continue?";
	okBtn.textContent = confirmText || "Confirm";
	modal.classList.remove("hidden");
	// F5 — capture focus and restore the previously focused element on close.
	var previouslyFocused = document.activeElement;
	okBtn.focus();

	var focusables = () =>
		modal.querySelectorAll(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);

	return new Promise((resolve) => {
		var cleanup = () => {
			modal.classList.add("hidden");
			cancelBtn.removeEventListener("click", onCancel);
			okBtn.removeEventListener("click", onConfirm);
			modal.removeEventListener("click", onBackdrop);
			document.removeEventListener("keydown", onKeydown);
			// F5 — return focus to the element that opened the dialog.
			if (previouslyFocused && typeof previouslyFocused.focus === "function") {
				try {
					previouslyFocused.focus();
				} catch (e) {
					/* ignore */
				}
			}
		};
		var finish = (value) => {
			cleanup();
			resolve(value);
		};
		var onCancel = () => finish(false);
		var onConfirm = () => finish(true);
		var onBackdrop = (e) => {
			if (e.target === modal) finish(false);
		};
		var onKeydown = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				finish(false);
				return;
			}
			if (e.key === "Enter") {
				finish(true);
				return;
			}
			// F5 — trap Tab focus within the dialog.
			if (e.key === "Tab") {
				var items = focusables();
				if (!items.length) return;
				var list = Array.prototype.slice
					.call(items)
					.filter((n) => n.offsetParent !== null);
				if (!list.length) return;
				var first = list[0];
				var last = list[list.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		cancelBtn.addEventListener("click", onCancel);
		okBtn.addEventListener("click", onConfirm);
		modal.addEventListener("click", onBackdrop);
		document.addEventListener("keydown", onKeydown);
	});
};

window.SDGui.manager = (() => {
	var cachedReleases = null;
	var installPollTimer = null;
	var installPollStartTime = null;
	var installPollFailCount = 0;
	var installPollInFlight = false;
	var latestStatus = null;
	var latestAppUpdateStatus = null;

	var INSTALL_POLL_TIMEOUT_MS = 10 * 60 * 1000;
	var INSTALL_POLL_MAX_FAILS = 5;

	function fetchJson(url, options) {
		return window.SDGui.fetchJson(url, options);
	}

	function renderBackendOptions(status) {
		var backendSelect = document.getElementById("backend-select");
		if (!backendSelect) return;
		var available = Array.isArray(status && status.available_backends)
			? status.available_backends
			: [];
		var current =
			status && status.backend ? status.backend : backendSelect.value;
		backendSelect.replaceChildren();
		if (available.length === 0) {
			backendSelect.appendChild(
				new Option("No supported backends for this platform", ""),
			);
			backendSelect.disabled = true;
			return;
		}
		backendSelect.disabled = false;
		available.forEach((b) => {
			backendSelect.appendChild(new Option(b.label, b.id));
		});
		var hasCurrent = Array.from(backendSelect.options).some(
			(o) => o.value === current,
		);
		backendSelect.value = hasCurrent ? current : available[0].id;
	}

	async function fetchReleases(force) {
		var sel = document.getElementById("release-select");
		if (!sel) return;
		sel.replaceChildren(new Option("Loading...", ""));
		try {
			var url = "/api/releases" + (force ? "?force=1" : "");
			cachedReleases = await fetchJson(url);
			sel.replaceChildren();
			cachedReleases.forEach((r) => {
				var date = new Date(r.published).toLocaleDateString();
				sel.appendChild(new Option(r.tag + "  (" + date + ")", r.tag));
			});
			if (latestStatus && latestStatus.version) {
				var hasInstalled = Array.from(sel.options).some(
					(o) => o.value === latestStatus.version,
				);
				if (hasInstalled) {
					sel.value = latestStatus.version;
					return;
				}
			}
			if (cachedReleases.length > 0) sel.value = cachedReleases[0].tag;
		} catch (e) {
			sel.replaceChildren(new Option("Failed to load", ""));
			showStatus("error", "Failed to fetch releases: " + e.message);
		}
	}

	async function checkStatus() {
		try {
			var status = await fetchJson("/api/status");
			if (!status) return null;
			latestStatus = status;
			updateStatusUI(status);
			return status;
		} catch (e) {
			return null;
		}
	}

	function updateStatusUI(status) {
		if (!status) return;
		var badge = document.getElementById("version-badge");
		var info = document.getElementById("installed-info");
		var repairBtn = document.getElementById("btn-repair");
		var backendSelect = document.getElementById("backend-select");
		var releaseSelect = document.getElementById("release-select");
		var installBtn = document.getElementById("btn-install");
		var sidebarStatus = document.getElementById("sidebar-status");
		var sidebarStatusText = document.getElementById("sidebar-status-text");

		renderBackendOptions(status);
		if (installBtn)
			installBtn.disabled =
				!status.available_backends || status.available_backends.length === 0;

		if (
			(status.installed || status.config_stale) &&
			status.backend &&
			backendSelect
		) {
			var hasBackend = Array.from(backendSelect.options).some(
				(o) => o.value === status.backend,
			);
			if (hasBackend) backendSelect.value = status.backend;
		}
		if (
			(status.installed || status.config_stale) &&
			status.version &&
			releaseSelect
		) {
			var hasTag = Array.from(releaseSelect.options).some(
				(o) => o.value === status.version,
			);
			if (hasTag) releaseSelect.value = status.version;
		}

		if (badge) {
			if (status.installed) {
				badge.textContent =
					(status.installed_version_name || status.version) +
					" (" +
					status.backend +
					")";
				badge.className = "badge badge-green";
			} else if (status.config_stale) {
				badge.textContent = "Install Incomplete";
				badge.className = "badge badge-yellow";
			} else {
				badge.textContent = "Not Installed";
				badge.className = "badge badge-neutral";
			}
		}
		if (repairBtn) repairBtn.classList.toggle("hidden", !status.config_stale);

		if (status.running) {
			if (sidebarStatus) sidebarStatus.style.display = "";
			if (sidebarStatusText)
				sidebarStatusText.textContent =
					(status.active_process_tool || "sd-cli") + " running";
		} else if (sidebarStatus) {
			sidebarStatus.style.display = "none";
		}

		if (!info) return;
		info.replaceChildren();

		var appendRow = (label, value) => {
			var row = document.createElement("div");
			var strong = document.createElement("strong");
			strong.textContent = label + ":";
			row.appendChild(strong);
			row.appendChild(document.createTextNode(" " + value));
			info.appendChild(row);
		};

		if (status.installed) {
			appendRow(
				"Version",
				String(status.installed_version_name || status.version),
			);
			appendRow("Backend", String(status.backend));
			var exeWrap = document.createElement("div");
			var exeTitle = document.createElement("strong");
			exeTitle.textContent = "Executables:";
			exeWrap.appendChild(exeTitle);
			exeWrap.appendChild(document.createElement("br"));
			Object.entries(status.executables || {}).forEach((entry) => {
				var name = entry[0];
				var exists = entry[1];
				var line = document.createElement("span");
				line.className = exists ? "exe-ok" : "exe-missing";
				line.textContent = (exists ? "✓ " : "✗ ") + name;
				exeWrap.appendChild(line);
				exeWrap.appendChild(document.createElement("br"));
			});
			info.appendChild(exeWrap);
		} else if (status.config_stale) {
			var missing = Array.isArray(status.missing_runtime_files)
				? status.missing_runtime_files.filter(Boolean)
				: [];
			var warn = document.createElement("div");
			warn.style.color = "var(--yellow)";
			warn.style.marginBottom = "8px";
			warn.textContent =
				missing.length > 0
					? "Configuration exists, but required stable-diffusion.cpp runtime libraries are missing."
					: "Configuration exists, but required executables are missing.";
			info.appendChild(warn);
			if (missing.length > 0) {
				var m = document.createElement("div");
				m.style.color = "var(--fg-faint)";
				m.style.marginBottom = "8px";
				m.textContent =
					"Missing runtime libraries: " + missing.slice(0, 8).join(", ");
				info.appendChild(m);
			}
			var hint = document.createElement("div");
			hint.style.color = "var(--fg-faint)";
			hint.textContent =
				"Click Repair Install to reinstall the configured version/backend.";
			info.appendChild(hint);
			appendRow("Version (config)", String(status.version));
			appendRow("Backend (config)", String(status.backend));
		} else {
			var empty = document.createElement("span");
			empty.style.color = "var(--fg-faint)";
			var platformText = status.platform_label
				? status.platform_label + " (" + status.arch + ")"
				: "this system";
			if (
				!status.available_backends ||
				status.available_backends.length === 0
			) {
				empty.textContent =
					"No prebuilt stable-diffusion.cpp backends are configured for " +
					platformText +
					".";
			} else {
				empty.textContent =
					"No stable-diffusion.cpp installation found for " +
					platformText +
					". Select a version above and click Install.";
			}
			info.appendChild(empty);
		}
	}

	async function startInstall(tag, backend, startMessage) {
		showStatus("info", startMessage);
		setInstallButtonsDisabled(true);
		showProgress(true);
		try {
			var result = await fetchJson("/api/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tag: tag, backend: backend }),
			});
			if (result.error) {
				showStatus("error", result.error);
				showProgress(false);
				setInstallButtonsDisabled(false);
			} else {
				pollInstallProgress();
			}
		} catch (e) {
			showStatus("error", "Install request failed: " + e.message);
			showProgress(false);
			setInstallButtonsDisabled(false);
		}
	}

	async function installRelease() {
		var tag = document.getElementById("release-select").value;
		var backend = document.getElementById("backend-select").value;
		if (!tag) {
			showStatus("error", "Select a version first");
			return;
		}
		await startInstall(
			tag,
			backend,
			"Installing " + tag + " (" + backend + ")...",
		);
	}

	async function repairInstall() {
		var status = latestStatus || (await checkStatus());
		if (!status || !status.version || !status.backend) {
			showStatus("error", "No saved installation config found to repair.");
			return;
		}
		var ok = await window.SDGui.confirmAction(
			"Repair Install",
			"Repair installation for " +
				status.version +
				" (" +
				status.backend +
				")? This will replace existing stable-diffusion.cpp binaries.",
			"Repair",
		);
		if (!ok) return;
		await startInstall(
			status.version,
			status.backend,
			"Repairing " + status.version + " (" + status.backend + ")...",
		);
	}

	async function removeSdcppFiles() {
		var status = latestStatus || (await checkStatus());
		if (status && status.running) {
			showStatus("error", "Stop the running process before cleaning files.");
			return;
		}
		var ok = await window.SDGui.confirmAction(
			"Remove Binaries",
			"Delete all files under sdcpp/ and clear install metadata? Models, presets, and output are kept.",
			"Remove",
		);
		if (!ok) return;
		try {
			var result = await fetchJson("/api/cleanup-sdcpp", { method: "POST" });
			showStatus(
				"success",
				"Removed " + (result.removed_files || 0) + " file(s).",
			);
			checkStatus();
		} catch (e) {
			showStatus("error", "Cleanup failed: " + e.message);
		}
	}

	async function checkForUpdates() {
		showStatus("info", "Checking for updates...");
		try {
			var result = await fetchJson("/api/update", { method: "POST" });
			if (result.error) {
				showStatus("error", result.error);
			} else if (result.status === "already_latest") {
				showStatus("success", "Already on the latest version");
			} else if (result.status === "started") {
				showStatus(
					"info",
					"Updating from " + result.from + " to " + result.to + "...",
				);
				setInstallButtonsDisabled(true);
				showProgress(true);
				pollInstallProgress();
			}
		} catch (e) {
			showStatus("error", "Update check failed: " + e.message);
		}
	}

	function stopInstallProgressPolling() {
		if (installPollTimer) {
			clearInterval(installPollTimer);
			installPollTimer = null;
		}
		installPollStartTime = null;
		installPollFailCount = 0;
		installPollInFlight = false;
	}

	function pollInstallProgress() {
		stopInstallProgressPolling();
		installPollStartTime = Date.now();
		installPollTimer = setInterval(async () => {
			if (Date.now() - installPollStartTime > INSTALL_POLL_TIMEOUT_MS) {
				stopInstallProgressPolling();
				showStatus(
					"error",
					"Installation timed out. The server may have stopped responding.",
				);
				showProgress(false);
				setInstallButtonsDisabled(false);
				return;
			}
			if (installPollInFlight) return;
			installPollInFlight = true;
			try {
				var prog = await fetchJson("/api/download-progress");
				installPollFailCount = 0;
				updateProgressBar(prog);
				if (prog.status === "done") {
					stopInstallProgressPolling();
					showStatus("success", prog.message);
					showProgress(false);
					setInstallButtonsDisabled(false);
					checkStatus();
				} else if (prog.status === "error") {
					stopInstallProgressPolling();
					showStatus("error", prog.message);
					showProgress(false);
					setInstallButtonsDisabled(false);
				}
			} catch (e) {
				installPollFailCount++;
				if (installPollFailCount >= INSTALL_POLL_MAX_FAILS) {
					stopInstallProgressPolling();
					showStatus(
						"error",
						"Lost contact with the server during installation.",
					);
					showProgress(false);
					setInstallButtonsDisabled(false);
				}
			} finally {
				installPollInFlight = false;
			}
		}, 500);
	}

	function updateProgressBar(prog) {
		var fill = document.getElementById("progress-fill");
		var text = document.getElementById("progress-text");
		if (prog.total > 0) {
			var pct = Math.round((prog.downloaded / prog.total) * 100);
			if (fill) fill.style.width = pct + "%";
			if (text) {
				var dlMB = (prog.downloaded / 1048576).toFixed(1);
				var totMB = (prog.total / 1048576).toFixed(1);
				text.textContent =
					(prog.status === "extracting"
						? "Extracting... "
						: "Downloading... ") +
					pct +
					"% (" +
					dlMB +
					" / " +
					totMB +
					" MB)";
			}
		} else if (prog.status === "extracting") {
			if (fill) {
				fill.style.width = "100%";
				fill.style.background = "var(--yellow)";
			}
			if (text) text.textContent = "Extracting files...";
		} else if (text) {
			text.textContent = prog.message || prog.status;
		}
	}

	function showProgress(visible) {
		var el = document.getElementById("download-progress");
		var fill = document.getElementById("progress-fill");
		var text = document.getElementById("progress-text");
		if (visible) {
			el.classList.remove("hidden");
			if (fill) {
				fill.style.width = "0%";
				fill.style.background = "";
			}
			if (text) text.textContent = "Starting...";
		} else {
			el.classList.add("hidden");
		}
	}

	function showStatus(type, message) {
		var el = document.getElementById("install-status");
		if (!el) return;
		el.className = "status-box " + (type || "");
		el.textContent = message || "";
		el.style.display = type ? "" : "none";
	}

	function showAppUpdateStatus(type, message) {
		var el = document.getElementById("app-update-status");
		if (!el) return;
		el.className = "status-box " + (type || "");
		el.textContent = message || "";
		el.style.display = type ? "" : "none";
	}

	function describeAppUpdateStatus(status) {
		if (!status) return "Unable to determine app update status.";
		if (status.reason && !status.available) return status.reason;
		var fmt = (paths) => {
			var list = Array.isArray(paths) ? paths.filter(Boolean) : [];
			if (list.length === 0) return "";
			return list.slice(0, 8).join(", ");
		};
		var blocking = fmt(status.blocking_dirty_paths);
		var safe = fmt(status.safe_dirty_paths);
		var branch = status.branch ? "branch " + status.branch : "current branch";
		if (status.state === "up_to_date") {
			var note = safe
				? " Local app data is present and ignored: " + safe + "."
				: "";
			return "Stable-D GUI is up to date on " + branch + "." + note;
		}
		if (status.state === "behind") {
			var n = status.behind || 0;
			if (status.has_blocking_changes)
				return (
					"Update available (" +
					n +
					" behind), but source changes must be committed/stashed first. Blocking: " +
					blocking
				);
			return "Update available: " + n + " commit(s) behind origin.";
		}
		if (status.state === "ahead")
			return "Local branch is ahead of origin; auto-update is disabled.";
		if (status.state === "diverged")
			return "Local and remote branches diverged; update manually with git.";
		return "App update status available, but cannot auto-update in current state.";
	}

	function renderAppUpdateStatus(status) {
		latestAppUpdateStatus = status;
		var msg = describeAppUpdateStatus(status);
		var type = "info";
		if (!status || status.error) type = "error";
		else if (status.state === "up_to_date") type = "success";
		else if (status.state === "behind")
			type = status.can_update ? "info" : "error";
		else if (status.state === "ahead" || status.state === "diverged")
			type = "error";
		showAppUpdateStatus(type, msg);
		var updateBtn = document.getElementById("btn-update-app");
		if (updateBtn && status) {
			updateBtn.disabled = !status.can_update;
			updateBtn.title = status.can_update
				? "Pull latest changes from GitHub"
				: msg;
		}
	}

	async function checkAppUpdateStatus() {
		showAppUpdateStatus("info", "Checking app update status...");
		try {
			var status = await fetchJson("/api/app-update-status");
			renderAppUpdateStatus(status);
		} catch (e) {
			showAppUpdateStatus("error", "Failed to check app updates: " + e.message);
		}
	}

	async function updateAppFromGitHub() {
		var status =
			latestAppUpdateStatus || (await fetchJson("/api/app-update-status"));
		if (!status.can_update) {
			renderAppUpdateStatus(status);
			return;
		}
		var ok = await window.SDGui.confirmAction(
			"Update Stable-D GUI",
			"Pull latest changes from GitHub now? Python dependencies will be reinstalled. The app restarts after updating.",
			"Update",
		);
		if (!ok) return;
		showAppUpdateStatus("info", "Pulling latest changes from GitHub...");
		try {
			var result = await fetchJson("/api/app-update", { method: "POST" });
			if (result.updated) {
				if (result.dependency_error) {
					showAppUpdateStatus(
						"warning",
						"App updated, but dependency install failed: " +
							result.dependency_error,
					);
				} else {
					await restartPythonServerAndReload({
						showStatusFn: showAppUpdateStatus,
						restartingMessage: "App updated. Restarting Stable-D GUI...",
						successMessage: "Stable-D GUI restarted.",
					});
					return;
				}
			} else if (result.message) {
				showAppUpdateStatus("info", result.message);
			}
			if (result.status) renderAppUpdateStatus(result.status);
			else checkAppUpdateStatus();
		} catch (e) {
			showAppUpdateStatus("error", "App update failed: " + e.message);
		}
	}

	async function stopPythonServer() {
		var ok = await window.SDGui.confirmAction(
			"Stop GUI Server",
			"Stop this Stable-D GUI server? The page will disconnect until you start server.py again.",
			"Stop Server",
		);
		if (!ok) return;
		var button = document.getElementById("btn-stop-app");
		if (button) button.disabled = true;
		showStatus("info", "Stopping GUI server...");
		try {
			await fetchJson("/api/shutdown", { method: "POST" });
			showStatus(
				"success",
				"GUI server is shutting down. This page will stop responding.",
			);
			setTimeout(() => window.location.reload(), 1500);
		} catch (e) {
			showStatus("error", "Failed to stop GUI server: " + e.message);
			if (button) button.disabled = false;
		}
	}

	async function restartPythonServer() {
		var ok = await window.SDGui.confirmAction(
			"Restart GUI Server",
			"Restart the Stable-D GUI server? The page will briefly disconnect.",
			"Restart",
		);
		if (!ok) return;
		await restartPythonServerAndReload({
			showStatusFn: showStatus,
			restartingMessage: "Restarting GUI server...",
			successMessage: "GUI server restarted successfully.",
		});
	}

	async function restartPythonServerAndReload(options) {
		options = options || {};
		var showStatusFn = options.showStatusFn || showStatus;
		showStatusFn("info", options.restartingMessage || "Restarting...");
		try {
			await fetchJson("/api/restart", { method: "POST" });
			showStatusFn("info", "Reconnecting...");
			var ready = await waitForServerReady(30, 1000);
			if (ready)
				showStatusFn("success", options.successMessage || "Restarted.");
			else
				showStatusFn("error", "Server did not become ready. Reload manually.");
			setTimeout(reloadAppWithCacheBust, 500);
		} catch (e) {
			showStatusFn("error", "Restart failed: " + e.message);
		}
	}

	function reloadAppWithCacheBust() {
		var url = new URL(window.location.href);
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		url.searchParams.set("appReload", Date.now().toString());
		window.location.replace(url.toString());
	}

	async function waitForServerReady(maxRetries, intervalMs) {
		for (var i = 0; i < maxRetries; i++) {
			try {
				await fetchJson("/api/status");
				return true;
			} catch (e) {
				await new Promise((r) => setTimeout(r, intervalMs));
			}
		}
		return false;
	}

	function openFolder(folder) {
		fetchJson("/api/open-folder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder: folder }),
		})
			.then(() => showStatus("info", "Opened " + folder + " folder."))
			.catch((e) => showStatus("error", "Failed to open folder: " + e.message));
	}

	function setInstallButtonsDisabled(disabled) {
		var ids = [
			"btn-install",
			"btn-update",
			"btn-repair",
			"btn-remove-sdcpp",
			"btn-stop-app",
			"btn-restart-app",
			"btn-check-app-update",
			"btn-update-app",
			"refresh-releases",
		];
		ids.forEach((id) => {
			var el = document.getElementById(id);
			if (el) el.disabled = disabled;
		});
	}

	function init() {
		var wire = (id, handler) => {
			var el = document.getElementById(id);
			if (el) el.addEventListener("click", handler);
		};
		wire("btn-install", installRelease);
		wire("btn-update", checkForUpdates);
		wire("btn-repair", repairInstall);
		wire("btn-remove-sdcpp", removeSdcppFiles);
		wire("btn-open-models", () => openFolder("models"));
		wire("btn-open-sdcpp", () => openFolder("sdcpp"));
		wire("btn-open-output", () => openFolder("output"));
		wire("btn-stop-app", stopPythonServer);
		wire("btn-restart-app", restartPythonServer);
		wire("btn-check-app-update", checkAppUpdateStatus);
		wire("btn-update-app", updateAppFromGitHub);
		wire("refresh-releases", () => fetchReleases(true));

		fetchReleases(false);
		checkStatus();
		checkAppUpdateStatus();

		if (window.addEventListener)
			window.addEventListener("beforeunload", stopInstallProgressPolling);
	}

	return { init: init, checkStatus: checkStatus };
})();
