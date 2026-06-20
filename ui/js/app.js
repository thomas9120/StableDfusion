// Main orchestration: tab switching, module init, status badge polling.
// Mirrors LLama-GUI's app.js (trimmed: no chat/benchmark wiring).
window.SDGui = window.SDGui || {};

(() => {
	function switchSection(section) {
		document.querySelectorAll(".section-panel").forEach((el) => {
			el.style.display = "none";
		});
		var panel = document.getElementById("section-" + section);
		if (panel) panel.style.display = "block";

		document.querySelectorAll(".nav-item").forEach((btn) => {
			btn.classList.toggle(
				"active",
				btn.getAttribute("data-section") === section,
			);
		});
	}

	async function refreshStatusBadge() {
		try {
			var data = await window.SDGui.fetchJson("/api/status");
			var badge = document.getElementById("version-badge");
			if (badge && data && data.installed && data.installed.tag) {
				badge.textContent =
					data.installed.tag + " / " + (data.installed.backend || "?");
				badge.classList.remove("badge-neutral");
			}
		} catch (e) {
			/* server may be busy starting up; ignore */
		}
	}

	function initNav() {
		document.querySelectorAll(".nav-item").forEach((btn) => {
			btn.addEventListener("click", () => {
				switchSection(btn.getAttribute("data-section"));
			});
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

	document.addEventListener("DOMContentLoaded", () => {
		initNav();
		initModules();
		refreshStatusBadge();
		window.setInterval(refreshStatusBadge, 5000);
	});
})();
