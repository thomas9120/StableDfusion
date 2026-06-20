// GitHub releases, install/update, and the shared fetchJson() utility.
// Mirrors LLama-GUI's manager.js. TODO(Phase 1).
window.SDGui = window.SDGui || {};

// Shared API helper. Returns parsed JSON, or null for non-JSON 200 responses.
// Callers must handle null gracefully (PLAN.md error-handling expectations).
window.SDGui.fetchJson = async (url, options) => {
	try {
		var resp = await fetch(url, options);
		var text = await resp.text();
		if (!text) return null;
		return JSON.parse(text);
	} catch (e) {
		console.warn("fetchJson error", url, e);
		throw e;
	}
};

window.SDGui.manager = {
	init: () => {
		// TODO(Phase 1): load /api/releases, populate release/backend selects,
		// wire install/update/repair/remove + download-progress polling.
	},
};
