// API endpoint snippets for the running sd-server (/sdcpp/v1, /v1, /sdapi/v1).
window.SDGui = window.SDGui || {};

window.SDGui.apiTab = (() => {
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function endpointBase(status) {
		if (status && status.target_url)
			return String(status.target_url).replace(/\/+$/, "");
		return "http://127.0.0.1:1234";
	}

	function guiBase() {
		return window.location.origin;
	}

	function snippet(title, text) {
		var box = el("div", "api-snippet");
		box.appendChild(el("div", "api-snippet-title", title));
		var pre = el("pre", "command-preview", text);
		box.appendChild(pre);
		// B1 — Copy button per snippet.
		window.SDGui.attachCopyButton(pre, () => text);
		return box;
	}

	function render(status) {
		var root = document.getElementById("api-endpoints");
		if (!root) return;
		var target = endpointBase(status);
		var proxy = guiBase();
		var running = status && status.status === "running";
		var title = el("h3", "", "API endpoints");
		var state = el(
			"p",
			"help-text",
			running
				? "sd-server is running. Use the direct target locally or the GUI proxy/tunnel URLs remotely."
				: "Start sd-server to activate these targets.",
		);
		var group = el("div", "api-snippet-group");
		group.appendChild(
			snippet(
				"OpenAI-compatible image endpoint",
				[
					"POST " + target + "/v1/images/generations",
					"POST " + proxy + "/v1/images/generations",
				].join("\n"),
			),
		);
		group.appendChild(
			snippet(
				"Stable Diffusion WebUI API",
				[
					"POST " + target + "/sdapi/v1/txt2img",
					"POST " + proxy + "/sdapi/v1/txt2img",
				].join("\n"),
			),
		);
		group.appendChild(
			snippet(
				"stable-diffusion.cpp API",
				[
					"POST " + target + "/sdcpp/v1/txt2img",
					"POST " + proxy + "/sdcpp/v1/txt2img",
				].join("\n"),
			),
		);
		root.replaceChildren(title, state, group);
	}

	function init() {
		render(
			window.SDGui.serverUi && window.SDGui.serverUi.getStatus
				? window.SDGui.serverUi.getStatus()
				: null,
		);
		window.addEventListener("sdgui:sd-server-status", (event) =>
			render(event.detail),
		);
	}

	return { init: init, render: render };
})();
