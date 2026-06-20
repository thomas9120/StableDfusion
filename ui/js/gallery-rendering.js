// Image + history DOM rendering helpers (the gallery analog of chat-rendering.js).
// Pure DOM construction throughout (no innerHTML). Used by generate-ui.js.
window.SDGui = window.SDGui || {};

window.SDGui.gallery = (() => {
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function imageUrl(name, bust) {
		var url = "/api/image/" + encodeURIComponent(name);
		if (bust) url += "?t=" + bust;
		return url;
	}

	// Render the main result image into a container (clears it first).
	function renderResultImage(container, name, altText, bust) {
		if (!container) return;
		container.replaceChildren();
		if (!name) return;
		var img = el("img");
		img.src = imageUrl(name, bust);
		img.alt = altText || "result";
		container.appendChild(img);
	}

	// Build a single history thumbnail element.
	function createHistoryItem(entry, onClick) {
		var item = el("div", "history-item");
		item.title = entry.prompt || entry.name || "";
		var img = el("img");
		img.src = entry.thumb || (entry.name ? imageUrl(entry.name) : "");
		img.alt = entry.prompt || "";
		img.loading = "lazy";
		item.appendChild(img);
		if (entry.prompt) {
			item.appendChild(el("div", "history-prompt", entry.prompt));
		}
		if (typeof onClick === "function") {
			item.addEventListener("click", () => onClick(entry));
		}
		return item;
	}

	// Render the whole history grid from an entries array (newest first).
	function renderHistoryGrid(container, entries, onRestore) {
		if (!container) return;
		container.replaceChildren();
		(entries || []).forEach((entry) => {
			container.appendChild(createHistoryItem(entry, onRestore));
		});
	}

	// Render a gallery of result files (used when batch_count > 1).
	function renderResultGallery(container, files, altText, bust) {
		if (!container) return;
		container.replaceChildren();
		(files || []).slice(0, 12).forEach((name) => {
			var cell = el("div", "history-item");
			var img = el("img");
			img.src = imageUrl(name, bust);
			img.alt = altText || "result";
			cell.appendChild(img);
			container.appendChild(cell);
		});
	}

	return {
		renderResultImage: renderResultImage,
		renderHistoryGrid: renderHistoryGrid,
		renderResultGallery: renderResultGallery,
		createHistoryItem: createHistoryItem,
		imageUrl: imageUrl,
	};
})();
