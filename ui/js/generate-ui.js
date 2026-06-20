// PRIMARY Generate tab: prompt UI, bundle-driven model pickers, generate action,
// live preview polling, gallery + history. Mirrors LLama-GUI's chat-ui.js in
// shape (it owns a tab's state + streaming flow), adapted to image generation.
// TODO(Phase 2/3). See PLAN.md §10.
window.SDGui = window.SDGui || {};

window.SDGui.generateUi = {
	init: () => {
		const bundleSelect = document.getElementById("gen-model-bundle");
		if (bundleSelect) {
			// Safe DOM construction (no innerHTML) for the bundle dropdown.
			bundleSelect.replaceChildren();
			(window.SDGui.MODEL_TYPE_BUNDLES || []).forEach((b) => {
				bundleSelect.appendChild(new Option(b.label, b.value));
			});
			bundleSelect.addEventListener("change", () => {
				window.SDGui.flagCore.setBundle(bundleSelect.value);
				window.SDGui.generateUi.renderBundleFields();
			});
		}
		const modeSelect = document.getElementById("gen-mode");
		if (modeSelect) {
			modeSelect.addEventListener("change", () => {
				window.SDGui.flagCore.setMode(modeSelect.value);
			});
		}
		const genBtn = document.getElementById("btn-generate");
		if (genBtn) {
			genBtn.addEventListener("click", () => {
				window.SDGui.generateUi.generate();
			});
		}
		this.renderBundleFields();
	},

	// Render the model-component file pickers for the current bundle.
	renderBundleFields: () => {
		const container = document.getElementById("gen-model-components");
		if (!container) return;
		// TODO(Phase 2/3): build a path input + Browse button (POST /api/select-file)
		// for each bundle field; "custom" bundle shows all fields.
		const note = document.createElement("p");
		note.className = "help-text";
		note.textContent =
			"Model component pickers render here once Phase 2 lands.";
		container.replaceChildren(note);
	},

	// POST /api/generate, then poll /api/generate/status + /api/generate/preview.
	generate: async () => {
		// TODO(Phase 2): collect flagCore state, POST, poll for step progress,
		// refresh the live <img> with cache-busted preview, push result to gallery.
		console.log("[generateUi] generate() — implemented in Phase 2");
	},
};
