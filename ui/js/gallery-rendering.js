// Image + history DOM rendering helpers (the gallery analog of chat-rendering.js).
// Uses safe DOM construction throughout (no innerHTML). TODO(Phase 2).
// See PLAN.md §10 (gallery, history in localStorage).
window.SDGui = window.SDGui || {};

window.SDGui.gallery = {
	renderResult: (container, imageUrl) => {
		if (!container) return;
		container.replaceChildren();
		if (!imageUrl) return;
		const img = document.createElement("img");
		img.src = imageUrl;
		img.alt = "result";
		container.appendChild(img);
	},

	renderHistory: (container, entries) => {
		if (!container) return;
		container.replaceChildren();
		(entries || []).forEach((e) => {
			const item = document.createElement("div");
			item.className = "history-item";
			const img = document.createElement("img");
			img.src = e.thumb;
			img.alt = e.prompt || "";
			item.appendChild(img);
			container.appendChild(item);
		});
	},
};
