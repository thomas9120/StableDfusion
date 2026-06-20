// Main orchestration: tab switching, module init, status polling.
// Mirrors LLama-GUI's app.js (trimmed: no chat/benchmark wiring).
window.SDGui = window.SDGui || {};

window.SDGui.ACTIVE_SECTION_KEY = "sdgui.activeSection";

window.SDGui.panelLifecycle = (() => {
	// D1 — per-section visibility hooks so modules can pause/resume polling.
	var handlers = {}; // section -> [ { start, stop } ]
	var activeSection = null;

	function register(section, start, stop) {
		if (!handlers[section]) handlers[section] = [];
		handlers[section].push({ start: start, stop: stop });
		// If this section is already active, start immediately.
		if (activeSection === section && typeof start === "function") start();
	}

	function setActive(section) {
		if (activeSection === section) return;
		// Stop previous section's pollers.
		if (activeSection && handlers[activeSection]) {
			handlers[activeSection].forEach((h) => {
				if (typeof h.stop === "function") {
					try {
						h.stop();
					} catch (e) {
						/* ignore */
					}
				}
			});
		}
		activeSection = section;
		if (section && handlers[section]) {
			handlers[section].forEach((h) => {
				if (typeof h.start === "function") {
					try {
						h.start();
					} catch (e) {
						/* ignore */
					}
				}
			});
		}
	}

	return { register: register, setActive: setActive };
})();

(() => {
	var DEFAULT_SECTION = "generate";
	var VALID_SECTIONS = [
		"install",
		"generate",
		"configure",
		"server",
		"hf-download",
		"presets",
	];

	function getSavedSection() {
		try {
			var saved = localStorage.getItem(window.SDGui.ACTIVE_SECTION_KEY);
			if (VALID_SECTIONS.indexOf(saved) !== -1) return saved;
		} catch (e) {
			/* ignore */
		}
		return DEFAULT_SECTION;
	}

	function saveActiveSection(section) {
		if (VALID_SECTIONS.indexOf(section) === -1) return;
		try {
			localStorage.setItem(window.SDGui.ACTIVE_SECTION_KEY, section);
		} catch (e) {
			/* ignore */
		}
	}

	function switchSection(section) {
		if (VALID_SECTIONS.indexOf(section) === -1) section = DEFAULT_SECTION;
		document.querySelectorAll(".section-panel").forEach((el) => {
			el.style.display = "none";
		});
		var panel = document.getElementById("section-" + section);
		if (panel) panel.style.display = "block";
		saveActiveSection(section);

		document.querySelectorAll(".nav-item").forEach((btn) => {
			btn.classList.toggle(
				"active",
				btn.getAttribute("data-section") === section,
			);
		});

		// D1 — let per-section pollers start/stop on visibility.
		window.SDGui.panelLifecycle.setActive(section);

		// E1 — close the mobile sidebar drawer after picking a section.
		var sidebar = document.getElementById("sidebar");
		if (sidebar && sidebar.classList.contains("open")) {
			sidebar.classList.remove("open");
			document.body.classList.remove("sidebar-open");
			var toggle = document.getElementById("btn-sidebar-toggle");
			if (toggle) toggle.setAttribute("aria-expanded", "false");
		}
	}

	// Lightweight sidebar-badge refresh. The Install tab's full status render
	// (executables, repair, etc.) is owned by manager.checkStatus(); we reuse
	// it when available so the badge + install panel stay in sync.
	async function refreshStatusBadge() {
		try {
			if (window.SDGui.manager && window.SDGui.manager.checkStatus) {
				await window.SDGui.manager.checkStatus();
				return;
			}
			var data = await window.SDGui.fetchJson("/api/status");
			var badge = document.getElementById("version-badge");
			if (badge && data && data.installed) {
				badge.textContent =
					(data.installed_version_name || data.version) +
					" (" +
					(data.backend || "?") +
					")";
				badge.className = "badge badge-green";
			}
		} catch (e) {
			/* server may be busy starting up; ignore */
		}
	}

	function initNav() {
		var navButtons = Array.prototype.slice.call(
			document.querySelectorAll(".nav-item"),
		);
		navButtons.forEach((btn) => {
			btn.addEventListener("click", () => {
				switchSection(btn.getAttribute("data-section"));
			});
		});
		// B2 — Alt+1..N jumps between sections; arrow keys move when a nav item is focused.
		document.addEventListener("keydown", (e) => {
			if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
				var idx = parseInt(e.code.slice(5), 10) - 1;
				var target = navButtons[idx];
				if (target) {
					e.preventDefault();
					switchSection(target.getAttribute("data-section"));
					target.focus();
				}
			}
		});
	}

	function initModules() {
		[
			window.SDGui.configFlagsUi,
			window.SDGui.manager,
			window.SDGui.presets,
			window.SDGui.generateUi,
			window.SDGui.hfDownloadUi,
			window.SDGui.serverUi,
			window.SDGui.apiTab,
			window.SDGui.remoteTunnelUi,
		].forEach((mod) => {
			if (mod && typeof mod.init === "function") {
				try {
					mod.init();
				} catch (e) {
					console.warn("module init failed", e);
				}
			}
		});
	}

	function initSidebarToggle() {
		// E1 — collapsible sidebar drawer for narrow viewports.
		var toggle = document.getElementById("btn-sidebar-toggle");
		var overlay = document.getElementById("sidebar-overlay");
		var sidebar = document.getElementById("sidebar");
		function close() {
			if (!sidebar) return;
			sidebar.classList.remove("open");
			document.body.classList.remove("sidebar-open");
			if (toggle) toggle.setAttribute("aria-expanded", "false");
		}
		function open() {
			if (!sidebar) return;
			sidebar.classList.add("open");
			document.body.classList.add("sidebar-open");
			if (toggle) {
				toggle.setAttribute("aria-expanded", "true");
				toggle.focus();
			}
		}
		if (toggle)
			toggle.addEventListener("click", () => {
				if (sidebar && sidebar.classList.contains("open")) close();
				else open();
			});
		if (overlay) overlay.addEventListener("click", close);
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && sidebar && sidebar.classList.contains("open"))
				close();
		});
		// Persist the desktop-collapsed preference is unnecessary; the drawer is
		// only used below 900px (CSS-gated), so no localStorage needed.
	}

	document.addEventListener("DOMContentLoaded", () => {
		initNav();
		initSidebarToggle();
		initModules();
		switchSection(getSavedSection());
		refreshStatusBadge();
		window.setInterval(refreshStatusBadge, 5000);
	});
})();
