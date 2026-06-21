// GitHub releases, install/update/repair/remove, and the shared fetchJson() +
// confirmAction() + toast() utilities. Mirrors LLama-GUI's manager.js, adapted
// to stable-diffusion.cpp (pattern-matched assets, sdcpp/ paths).
window.SDGui = window.SDGui || {};

window.SDGui.TOAST_MAX = 5;
window.SDGui.TOAST_LINGER_MS = 5000;
window.SDGui.TOAST_HOVER_MS = 2000;

function dismissToastNode(note) {
	if (!note || !note.parentNode || note.classList.contains("toast-out")) return;
	note.classList.add("toast-out");
	setTimeout(() => {
		if (note.parentNode) note.remove();
	}, 300);
}

window.SDGui.toast = (message, kind) => {
	var container = document.getElementById("toast-container");
	if (!container) return;
	while (container.children.length >= window.SDGui.TOAST_MAX) {
		dismissToastNode(container.firstChild);
	}
	var note = document.createElement("div");
	note.className = "toast toast-" + (kind || "info");

	var text = document.createElement("span");
	text.className = "toast-text";
	text.textContent = String(message || "");
	note.appendChild(text);

	var close = document.createElement("button");
	close.type = "button";
	close.className = "toast-close";
	close.setAttribute("aria-label", "Dismiss notification");
	close.textContent = "\u00d7";
	close.addEventListener("click", () => dismissToastNode(note));
	note.appendChild(close);

	container.appendChild(note);

	var timer = null;
	var arm = (ms) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => dismissToastNode(note), ms);
	};
	note.addEventListener("mouseenter", () => {
		if (timer) clearTimeout(timer);
	});
	note.addEventListener("mouseleave", () => arm(window.SDGui.TOAST_HOVER_MS));
	arm(window.SDGui.TOAST_LINGER_MS);
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

	function runtimeLabel(runtime) {
		if (!runtime) return "runtime";
		return String(runtime.tag || "?") + " (" + String(runtime.backend || "?") + ")";
	}

	function makeRuntimeButton(label, className, handler, disabled) {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = className || "btn btn-sm";
		btn.textContent = label;
		btn.disabled = !!disabled;
		btn.addEventListener("click", handler);
		return btn;
	}

	async function postRuntimeAction(endpoint, runtime) {
		return await fetchJson(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tag: runtime.tag,
				backend: runtime.backend,
			}),
		});
	}

	async function setActiveRuntime(runtime) {
		showStatus("info", "Switching active runtime to " + runtimeLabel(runtime) + "...");
		try {
			await postRuntimeAction("/api/sdcpp/active", runtime);
			showStatus("success", "Active runtime set to " + runtimeLabel(runtime) + ".");
			checkStatus();
		} catch (e) {
			showStatus("error", "Failed to switch runtime: " + e.message);
		}
	}

	async function repairRuntime(runtime) {
		var ok = await window.SDGui.confirmAction(
			"Repair Runtime",
			"Reinstall " + runtimeLabel(runtime) + "? This replaces only that runtime's binaries.",
			"Repair",
		);
		if (!ok) return;
		showStatus("info", "Repairing " + runtimeLabel(runtime) + "...");
		setInstallButtonsDisabled(true);
		showProgress(true);
		try {
			await postRuntimeAction("/api/sdcpp/repair", runtime);
			pollInstallProgress();
		} catch (e) {
			showStatus("error", "Repair request failed: " + e.message);
			showProgress(false);
			setInstallButtonsDisabled(false);
		}
	}

	async function updateRuntime(runtime) {
		showStatus("info", "Checking update for " + runtimeLabel(runtime) + "...");
		setInstallButtonsDisabled(true);
		showProgress(true);
		try {
			await postRuntimeAction("/api/sdcpp/update", runtime);
			pollInstallProgress();
		} catch (e) {
			showStatus("error", "Update request failed: " + e.message);
			showProgress(false);
			setInstallButtonsDisabled(false);
		}
	}

	async function removeRuntime(runtime) {
		var ok = await window.SDGui.confirmAction(
			"Remove Runtime",
			"Delete binaries for " +
				runtimeLabel(runtime) +
				"? Models, presets, and output are kept.",
			"Remove",
		);
		if (!ok) return;
		try {
			var result = await postRuntimeAction("/api/sdcpp/remove", runtime);
			showStatus(
				"success",
				"Removed " + (result.removed_files || 0) + " file(s).",
			);
			checkStatus();
		} catch (e) {
			showStatus("error", "Remove failed: " + e.message);
		}
	}

	function renderRuntimeList(status, container) {
		var runtimes = Array.isArray(status.installed_backends)
			? status.installed_backends
			: [];
		if (!runtimes.length) return false;
		var list = document.createElement("div");
		list.className = "runtime-list";
		runtimes.forEach((runtime) => {
			var row = document.createElement("div");
			row.className = "runtime-row" + (runtime.active ? " runtime-active" : "");

			var main = document.createElement("div");
			main.className = "runtime-main";
			var name = document.createElement("div");
			name.className = "runtime-name";
			name.textContent = runtimeLabel(runtime);
			var meta = document.createElement("div");
			meta.className = "runtime-meta";
			meta.textContent = runtime.path || "";
			main.appendChild(name);
			main.appendChild(meta);

			var statusChip = document.createElement("span");
			statusChip.className =
				"installed-chip " +
				(runtime.active
					? "installed-chip-primary"
					: runtime.exists
						? "installed-chip-ok"
						: "installed-chip-missing");
			statusChip.appendChild(
				document.createTextNode(runtime.active ? "Active" : runtime.exists ? "Ready" : "Missing"),
			);

			var actions = document.createElement("div");
			actions.className = "runtime-actions";
			actions.appendChild(
				makeRuntimeButton(
					"Set Active",
					"btn btn-sm",
					() => setActiveRuntime(runtime),
					runtime.active || !runtime.exists,
				),
			);
			actions.appendChild(
				makeRuntimeButton("Update", "btn btn-sm", () => updateRuntime(runtime), !runtime.exists),
			);
			actions.appendChild(
				makeRuntimeButton("Repair", "btn btn-sm", () => repairRuntime(runtime), false),
			);
			actions.appendChild(
				makeRuntimeButton("Remove", "btn btn-sm btn-danger", () => removeRuntime(runtime), false),
			);

			row.appendChild(main);
			row.appendChild(statusChip);
			row.appendChild(actions);
			list.appendChild(row);
		});
		container.appendChild(list);
		return true;
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
				badge.replaceChildren();
				var primary = document.createElement("span");
				primary.className = "badge-primary";
				primary.textContent =
					status.installed_version_name || status.version;
				badge.appendChild(primary);
				if (status.backend) {
					var sep = document.createElement("span");
					sep.className = "badge-sep";
					sep.textContent = " · ";
					badge.appendChild(sep);
					var secondary = document.createElement("span");
					secondary.className = "badge-secondary";
					secondary.textContent = status.backend;
					badge.appendChild(secondary);
				}
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
		var appendInstalledChip = (label, value, kind) => {
			var chip = document.createElement("span");
			chip.className = "installed-chip" + (kind ? " " + kind : "");
			var chipLabel = document.createElement("span");
			chipLabel.className = "installed-chip-label";
			chipLabel.textContent = label;
			var chipValue = document.createElement("span");
			chipValue.className = "installed-chip-value";
			chipValue.textContent = value;
			chip.appendChild(chipLabel);
			chip.appendChild(chipValue);
			info.appendChild(chip);
		};

		if (status.installed) {
			info.className = "";
			var summary = document.createElement("div");
			summary.className = "installed-grid";
			appendInstalledChip(
				"Version",
				String(status.installed_version_name || status.version),
				"installed-chip-primary",
			);
			appendInstalledChip("Backend", String(status.backend), "");
			while (info.firstChild) summary.appendChild(info.firstChild);
			info.appendChild(summary);
			Object.entries(status.executables || {}).forEach((entry) => {
				var name = entry[0];
				var exists = entry[1];
				appendInstalledChip(
					name,
					exists ? "Found" : "Missing",
					exists ? "installed-chip-ok" : "installed-chip-missing",
				);
			});
			renderRuntimeList(status, info);
		} else if (status.config_stale) {
			info.className = "";
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
			renderRuntimeList(status, info);
		} else {
			info.className = "";
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
			renderRuntimeList(status, info);
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
		var runtime =
			status && status.active_install
				? status.active_install
				: status && status.version && status.backend
					? { tag: status.version, backend: status.backend }
					: null;
		if (!runtime) {
			showStatus("error", "No active runtime found to repair.");
			return;
		}
		await repairRuntime(runtime);
	}

	async function removeSdcppFiles() {
		var status = latestStatus || (await checkStatus());
		if (status && status.running) {
			showStatus("error", "Stop the running process before cleaning files.");
			return;
		}
		var runtime =
			status && status.active_install
				? status.active_install
				: status && status.version && status.backend
					? { tag: status.version, backend: status.backend }
					: null;
		if (!runtime) {
			showStatus("error", "No active runtime found to remove.");
			return;
		}
		await removeRuntime(runtime);
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
			return "StableDfusion is up to date on " + branch + "." + note;
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

	function appUpdateStatusUrl(fetchRemote) {
		return "/api/app-update-status" + (fetchRemote ? "?fetch=true" : "");
	}

	async function checkAppUpdateStatus(fetchRemote) {
		showAppUpdateStatus("info", "Checking app update status...");
		try {
			var status = await fetchJson(appUpdateStatusUrl(fetchRemote));
			renderAppUpdateStatus(status);
		} catch (e) {
			showAppUpdateStatus("error", "Failed to check app updates: " + e.message);
		}
	}

	async function updateAppFromGitHub() {
		var status = await fetchJson(appUpdateStatusUrl(true));
		if (!status.can_update) {
			renderAppUpdateStatus(status);
			return;
		}
		var ok = await window.SDGui.confirmAction(
			"Update StableDfusion",
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
						restartingMessage: "App updated. Restarting StableDfusion...",
						successMessage: "StableDfusion restarted.",
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
			"Stop this StableDfusion server? The page will disconnect until you start server.py again.",
			"Stop Server",
		);
		if (!ok) return;
		var button = document.getElementById("btn-stop-app");
		if (button) button.disabled = true;
		showStatus("info", "Stopping GUI server...");
		try {
			await fetchJson("/api/shutdown", { method: "POST" });
			showStatus("info", "Shutdown requested. Waiting for server to stop...");
			var stopped = await waitForServerOffline(12, 500);
			showStatus(
				stopped ? "success" : "info",
				stopped
					? "GUI server stopped. Start server.py again to reconnect."
					: "Shutdown requested. This page may stop responding shortly.",
			);
		} catch (e) {
			showStatus("error", "Failed to stop GUI server: " + e.message);
			if (button) button.disabled = false;
		}
	}

	async function restartPythonServer() {
		var ok = await window.SDGui.confirmAction(
			"Restart GUI Server",
			"Restart the StableDfusion server? The page will briefly disconnect.",
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

	async function waitForServerOffline(maxRetries, intervalMs) {
		for (var i = 0; i < maxRetries; i++) {
			try {
				await fetchJson("/api/status");
			} catch (e) {
				return true;
			}
			await new Promise((r) => setTimeout(r, intervalMs));
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
		document.querySelectorAll(".runtime-actions button").forEach((el) => {
			el.disabled = disabled;
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
		wire("btn-check-app-update", () => checkAppUpdateStatus(true));
		wire("btn-update-app", updateAppFromGitHub);
		wire("refresh-releases", () => fetchReleases(true));

		fetchReleases(false);
		checkStatus();
		checkAppUpdateStatus(false);

		if (window.addEventListener)
			window.addEventListener("beforeunload", stopInstallProgressPolling);
	}

	return { init: init, checkStatus: checkStatus };
})();
