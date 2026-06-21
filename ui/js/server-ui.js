// Persistent sd-server tab: curated server flags, start/stop, status polling.
window.SDGui = window.SDGui || {};

window.SDGui.serverUi = (() => {
	var serverValues = {};
	var controls = {};
	var pollTimer = null;
	var lastStatus = null;
	var SERVER_LOCAL_IDS = {
		listen_ip: true,
		listen_port: true,
		serve_html_path: true,
		extra_args: true,
	};

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function fetchJson(url, options) {
		return window.SDGui.fetchJson(url, options);
	}

	function flags() {
		return window.SDGui.SD_SERVER_FLAGS || [];
	}

	function defaults() {
		flags().forEach((flag) => {
			if (isServerLocal(flag.id)) serverValues[flag.id] = flag.default;
		});
		serverValues.extra_args = "";
	}

	function isServerLocal(id) {
		return SERVER_LOCAL_IDS[id] === true;
	}

	function flagValues() {
		return window.SDGui.flagCore
			? window.SDGui.flagCore.getFlagValues()
			: {};
	}

	function valueFor(flag) {
		if (isServerLocal(flag.id)) return serverValues[flag.id];
		var vals = flagValues();
		return vals[flag.id];
	}

	function setValue(flag, value) {
		if (isServerLocal(flag.id)) {
			serverValues[flag.id] = value;
			renderCommandPreview();
			renderSummary();
			return;
		}
		window.SDGui.flagCore.setFlagValue(flag.id, value);
	}

	function normalizeControlValue(control, flag) {
		if (flag.type === "bool") return control.checked;
		var val = control.value;
		if (flag.type === "int") return val === "" ? "" : parseInt(val, 10);
		if (flag.type === "float") return val === "" ? "" : parseFloat(val);
		return val;
	}

	function syncControl(flag) {
		var control = controls[flag.id];
		if (!control || document.activeElement === control) return;
		var cur = valueFor(flag);
		if (cur === undefined || cur === null) cur = "";
		if (flag.type === "bool") {
			control.checked = cur === true;
		} else {
			control.value = String(cur);
		}
	}

	function syncSharedControls() {
		flags().forEach((flag) => {
			if (!isServerLocal(flag.id)) syncControl(flag);
		});
		renderCommandPreview();
		renderSummary();
	}

	function isWide(flag) {
		return (
			flag.type === "path" ||
			flag.id === "backend" ||
			flag.id === "params_backend" ||
			flag.id === "max_vram"
		);
	}

	function createControl(flag) {
		var wrap = el(
			"div",
			"form-group" + (isWide(flag) ? " server-flag-wide" : ""),
		);
		var label = el("label", "form-label", flag.label || flag.id);
		label.setAttribute("for", "server-" + flag.id);
		wrap.appendChild(label);

		var cur = valueFor(flag);
		var control = null;
		if (flag.type === "bool") {
			var toggle = el("label", "toggle");
			control = el("input");
			control.type = "checkbox";
			control.id = "server-" + flag.id;
			control.checked = cur === true;
			controls[flag.id] = control;
			toggle.appendChild(control);
			toggle.appendChild(
				document.createTextNode(flag.desc || flag.label || flag.id),
			);
			wrap.appendChild(toggle);
			control.addEventListener("change", () => {
				setValue(flag, control.checked);
			});
			return wrap;
		}

		if (flag.type === "enum") {
			control = el("select");
			var opts = window.SDGui.optionsForFlag(flag) || [];
			opts.forEach((opt) => control.appendChild(new Option(opt, opt)));
		} else {
			control = el("input");
			control.type =
				flag.type === "int" || flag.type === "float" ? "number" : "text";
			if (flag.type === "int") control.step = "1";
			if (flag.type === "float") control.step = "any";
		}
		control.id = "server-" + flag.id;
		if (cur !== undefined && cur !== null) control.value = String(cur);
		controls[flag.id] = control;
		control.addEventListener("input", () => {
			setValue(flag, normalizeControlValue(control, flag));
		});
		wrap.appendChild(control);
		return wrap;
	}

	function buildArgs() {
		var args = [];
		flags().forEach((flag) => {
			if (flag.id === "listen_ip" || flag.id === "listen_port") return;
			var v = valueFor(flag);
			if (v === undefined || v === null || v === "") return;
			if (v === flag.default) return;
			if (flag.type === "bool") {
				if (v === true) args.push([flag.flag]);
				return;
			}
			if (
				(flag.type === "int" || flag.type === "float") &&
				Number.isNaN(Number(v))
			) {
				return;
			}
			args.push([flag.flag, String(v)]);
		});
		return args;
	}

	function renderCommandPreview() {
		var pre = document.getElementById("server-command-preview");
		if (!pre) return;
		var flat = [
			"sd-server",
			"--listen-ip",
			String(serverValues.listen_ip || "127.0.0.1"),
			"--listen-port",
			String(serverValues.listen_port || 1234),
		];
		buildArgs().forEach((pair) => {
			flat.push.apply(flat, pair);
		});
		var extra = String(serverValues.extra_args || "").trim();
		if (extra) flat.push(extra);
		pre.textContent = flat.join(" ");
		// B1 — Copy button on the server command preview.
		window.SDGui.attachCopyButton(pre, () => flat.join(" "));
	}

	function renderSummary() {
		var root = document.getElementById("server-summary");
		if (!root) return;
		var host = String(serverValues.listen_ip || "127.0.0.1");
		var port = String(serverValues.listen_port || 1234);
		var changed = buildArgs().length;
		var endpoint = "http://" + host + ":" + port;
		var target = el("span", "server-summary-chip server-summary-url", endpoint);
		var mode = el(
			"span",
			"server-summary-chip",
			changed
				? changed + " advanced option" + (changed === 1 ? "" : "s")
				: "Default server options",
		);
		root.replaceChildren(target, mode);
	}

	function renderFlags() {
		var basic = document.getElementById("server-basic-flags");
		var advanced = document.getElementById("server-flags");
		controls = {};
		if (basic) basic.replaceChildren();
		if (advanced) advanced.replaceChildren();
		flags().forEach((flag) => {
			var target =
				flag.id === "listen_ip" || flag.id === "listen_port"
					? basic
					: advanced;
			if (target) target.appendChild(createControl(flag));
		});
		var extra = document.getElementById("server-extra-args");
		if (extra) {
			extra.value = serverValues.extra_args || "";
			extra.addEventListener("input", () => {
				serverValues.extra_args = extra.value;
				renderCommandPreview();
				renderSummary();
			});
		}
		renderCommandPreview();
		renderSummary();
	}

	function statusKind(status) {
		if (!status || status.status === "idle") return "info";
		if (status.status === "running") return "success";
		if (status.status === "error") return "error";
		return "warning";
	}

	function renderStatus(status) {
		lastStatus = status || {};
		var box = document.getElementById("server-status");
		var log = document.getElementById("server-log");
		var startBtn = document.getElementById("btn-sd-server-start");
		var stopBtn = document.getElementById("btn-sd-server-stop");
		var running =
			lastStatus.status === "running" || lastStatus.status === "starting";

		if (box) {
			box.className = "status-box " + statusKind(lastStatus);
			box.textContent = lastStatus.message || "sd-server is not running.";
			box.style.display = "";
		}
		if (log) log.textContent = lastStatus.log || "";
		if (startBtn) startBtn.disabled = running;
		if (stopBtn) stopBtn.disabled = !running;
		window.dispatchEvent(
			new CustomEvent("sdgui:sd-server-status", { detail: lastStatus }),
		);
	}

	async function refreshStatus() {
		try {
			renderStatus(await fetchJson("/api/sd-server/status"));
		} catch (e) {
			var box = document.getElementById("server-status");
			if (box) {
				box.className = "status-box error";
				box.textContent = "Failed to read sd-server status: " + e.message;
				box.style.display = "";
			}
		}
	}

	function stopPolling() {
		if (pollTimer) {
			window.clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function startPolling() {
		stopPolling();
		refreshStatus();
		pollTimer = window.setInterval(refreshStatus, 1500);
	}

	async function startServer() {
		var body = {
			host: serverValues.listen_ip || "127.0.0.1",
			port: serverValues.listen_port || 1234,
			args: buildArgs(),
			extra_args: serverValues.extra_args || "",
		};
		try {
			renderStatus({ status: "starting", message: "Starting sd-server..." });
			renderStatus(
				await fetchJson("/api/sd-server/start", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		} catch (e) {
			window.SDGui.toast("sd-server start failed: " + e.message, "error");
			await refreshStatus();
		}
	}

	async function stopServer() {
		try {
			await fetchJson("/api/sd-server/stop", { method: "POST" });
			await refreshStatus();
		} catch (e) {
			window.SDGui.toast("sd-server stop failed: " + e.message, "error");
		}
	}

	function init() {
		defaults();
		renderFlags();
		var startBtn = document.getElementById("btn-sd-server-start");
		var stopBtn = document.getElementById("btn-sd-server-stop");
		if (startBtn) startBtn.addEventListener("click", startServer);
		if (stopBtn) stopBtn.addEventListener("click", stopServer);
		window.SDGui.flagCore.onChange(syncSharedControls);
		refreshStatus();
		// D1 — only poll while the Server & API panel is visible.
		window.SDGui.panelLifecycle.register(
			"server",
			() => {
				startPolling();
			},
			() => {
				stopPolling();
			},
		);
		window.addEventListener("beforeunload", () => {
			if (pollTimer) window.clearInterval(pollTimer);
		});
	}

	return {
		init: init,
		refreshStatus: refreshStatus,
		getStatus: () => lastStatus,
		buildArgs: buildArgs,
	};
})();
