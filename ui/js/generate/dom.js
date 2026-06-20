// Small shared DOM helpers used across the Generate tab.
// Pure utilities — no state, no side effects beyond the DOM node passed in.
// Safe DOM only (no innerHTML) per AGENTS.md frontend pitfall.
window.SDGui = window.SDGui || {};

window.SDGui.generateDom = (() => {
	function $(id) {
		return document.getElementById(id);
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function setHidden(node, hidden) {
		if (node) node.classList.toggle("hidden", !!hidden);
	}

	function populateEnum(id, options, current) {
		var node = $(id);
		if (!node) return;
		node.replaceChildren();
		options.forEach((opt) => node.appendChild(new Option(opt, opt)));
		if (current !== undefined && current !== null) node.value = String(current);
	}

	return {
		$: $,
		el: el,
		setHidden: setHidden,
		populateEnum: populateEnum,
	};
})();
