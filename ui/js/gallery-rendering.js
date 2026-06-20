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

	// D2 — small thumbnail URL (served server-side) for 72px history cells.
	function thumbnailUrl(name) {
		return "/api/image/" + encodeURIComponent(name) + "/thumbnail";
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

	// Build a tiny SVG icon button for the history hover toolbar.
	function toolbarBtn(cls, title, svgPath) {
		var b = el("button", "history-action " + cls);
		b.type = "button";
		b.title = title;
		b.setAttribute("aria-label", title);
		var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
		p.setAttribute("d", svgPath);
		svg.appendChild(p);
		b.appendChild(svg);
		return b;
	}

	// Icon glyphs (stroke-based, 24x24, currentColor).
	var ICONS = {
		restore: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
		send: "M5 12h14m0 0l-6-6m6 6l-6 6",
		open: "M4 4h6v2H6v12h12v-4h2v6H4V4zm10 0h6v6",
		delete: "M6 7h12M9 7V5h6v2m-7 0v12h8V7",
		missing: "M4 4l16 16M21 5v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5",
	};

	// Build a single history thumbnail element with a hover toolbar.
	function createHistoryItem(entry, actions, opts) {
		actions = actions || {};
		opts = opts || {};
		var item = el("div", "history-item");
		item.setAttribute("data-id", entry.id || "");
		item.title = entry.prompt || entry.name || "";

		var img = el("img");
		var src = entry.thumb || (entry.file ? thumbnailUrl(entry.file) : "");
		img.src = src;
		img.alt = entry.prompt || "";
		img.loading = "lazy";
		// Broken image (e.g. output file deleted on disk): swap to a
		// "file missing" placeholder so the grid doesn't show a broken icon;
		// the delete action is then the natural way to prune stale entries.
		img.addEventListener("error", () => {
			item.classList.add("is-missing");
			img.style.display = "none";
			var ph = el("div", "history-missing");
			ph.appendChild(toolbarBtn("", "File missing", ICONS.missing));
			var lbl = el("span", "history-missing-label", "file missing");
			ph.appendChild(lbl);
			item.insertBefore(ph, item.firstChild);
		});
		item.appendChild(img);

		// Relative timestamp badge.
		if (typeof opts.timeLabel === "function") {
			var t = opts.timeLabel(entry.timestamp);
			if (t) item.appendChild(el("span", "history-time", t));
		}

		// Prompt overlay (shown on hover).
		if (entry.prompt) {
			item.appendChild(el("div", "history-prompt", entry.prompt));
		}

		// Hover toolbar: restore / send / copy / open / delete.
		var bar = el("div", "history-toolbar");
		bar.setAttribute("role", "toolbar");
		bar.setAttribute("aria-label", "History actions");
		if (typeof actions.onRestore === "function")
			bar
				.appendChild(toolbarBtn("restore", "Restore settings", ICONS.restore))
				.addEventListener("click", (ev) => {
					ev.stopPropagation();
					actions.onRestore(entry);
				});
		if (typeof actions.onSend === "function")
			bar
				.appendChild(toolbarBtn("send", "Send to img2img", ICONS.send))
				.addEventListener("click", (ev) => {
					ev.stopPropagation();
					actions.onSend(entry);
				});
		if (typeof actions.onOpen === "function")
			bar
				.appendChild(toolbarBtn("open", "View full size", ICONS.open))
				.addEventListener("click", (ev) => {
					ev.stopPropagation();
					actions.onOpen(entry);
				});
		if (typeof actions.onDelete === "function")
			bar
				.appendChild(toolbarBtn("danger", "Remove from history", ICONS.delete))
				.addEventListener("click", (ev) => {
					ev.stopPropagation();
					actions.onDelete(entry);
				});
		item.appendChild(bar);

		// Click anywhere else on the thumb = restore (preserves prior UX).
		if (typeof actions.onRestore === "function") {
			item.addEventListener("click", () => actions.onRestore(entry));
		}
		return item;
	}

	// Render the whole history grid from an entries array (newest first).
	function renderHistoryGrid(container, entries, actions, opts) {
		if (!container) return;
		container.replaceChildren();
		entries = entries || [];
		if (!entries.length) {
			var empty = el("div", "history-empty");
			var ico = el("span", "history-empty-icon");
			var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("aria-hidden", "true");
			var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p.setAttribute(
				"d",
				"M4 16l4.6-4.6a2 2 0 0 1 2.8 0L16 16m-2-2l1.6-1.6a2 2 0 0 1 2.8 0L20 14M4 6h16v14H4V6zm2 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
			);
			svg.appendChild(p);
			ico.appendChild(svg);
			empty.appendChild(ico);
			empty.appendChild(el("p", "", "No history yet."));
			empty.appendChild(
				el(
					"span",
					"history-empty-hint",
					"Images you generate will appear here.",
				),
			);
			container.appendChild(empty);
			return;
		}
		entries.forEach((entry) => {
			container.appendChild(createHistoryItem(entry, actions, opts));
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
		thumbnailUrl: thumbnailUrl,
	};
})();
