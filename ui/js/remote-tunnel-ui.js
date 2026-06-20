// Cloudflare tunnel UI: start/stop, URL + copy, status polling.
window.SDGui = window.SDGui || {};

window.SDGui.remoteTunnelUi = (() => {
	var latest = null;
	var serverStatus = null;
	var pollTimer = null;

	function fetchJson(url, options) {
		return window.SDGui.fetchJson(url, options);
	}

	function render(status) {
		latest = status || {};
		var box = document.getElementById("tunnel-status");
		var url = document.getElementById("tunnel-url");
		var log = document.getElementById("tunnel-log");
		var startBtn = document.getElementById("btn-tunnel-start");
		var stopBtn = document.getElementById("btn-tunnel-stop");
		var copyBtn = document.getElementById("btn-tunnel-copy");
		var running = latest.status === "running" || latest.status === "starting";

		if (box) {
			var kind = latest.status === "running" ? "success" : latest.status === "error" ? "error" : "info";
			box.className = "status-box " + kind;
			box.textContent = latest.message || "Remote tunnel is not running.";
			box.style.display = "";
		}
		if (url) url.textContent = latest.url || "";
		if (log) log.textContent = latest.log || "";
		if (startBtn) {
			startBtn.disabled =
				running || !serverStatus || serverStatus.status !== "running";
		}
		if (stopBtn) stopBtn.disabled = !running;
		if (copyBtn) copyBtn.disabled = !latest.url;
	}

	async function refresh() {
		try {
			render(await fetchJson("/api/remote-tunnel/status"));
		} catch (e) {
			var box = document.getElementById("tunnel-status");
			if (box) {
				box.className = "status-box error";
				box.textContent = "Failed to read tunnel status: " + e.message;
				box.style.display = "";
			}
		}
	}

	async function start() {
		var port = serverStatus && serverStatus.port ? serverStatus.port : 1234;
		try {
			render({ status: "starting", message: "Starting Cloudflare tunnel..." });
			render(
				await fetchJson("/api/remote-tunnel/start", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ port: port }),
				}),
			);
		} catch (e) {
			window.SDGui.toast("Tunnel start failed: " + e.message, "error");
			await refresh();
		}
	}

	async function stop() {
		try {
			await fetchJson("/api/remote-tunnel/stop", { method: "POST" });
			await refresh();
		} catch (e) {
			window.SDGui.toast("Tunnel stop failed: " + e.message, "error");
		}
	}

	async function copyUrl() {
		if (!latest || !latest.url) return;
		try {
			await navigator.clipboard.writeText(latest.url);
			window.SDGui.toast("Tunnel URL copied.", "success");
		} catch (e) {
			window.SDGui.toast("Copy failed: " + e.message, "error");
		}
	}

	function init() {
		var startBtn = document.getElementById("btn-tunnel-start");
		var stopBtn = document.getElementById("btn-tunnel-stop");
		var copyBtn = document.getElementById("btn-tunnel-copy");
		if (startBtn) startBtn.addEventListener("click", start);
		if (stopBtn) stopBtn.addEventListener("click", stop);
		if (copyBtn) copyBtn.addEventListener("click", copyUrl);
		window.addEventListener("sdgui:sd-server-status", (event) => {
			serverStatus = event.detail || {};
			render(latest || {});
		});
		refresh();
		pollTimer = window.setInterval(refresh, 3000);
		window.addEventListener("beforeunload", () => {
			if (pollTimer) window.clearInterval(pollTimer);
		});
	}

	return { init: init, refresh: refresh };
})();
