import { Window } from "happy-dom";

// Notebook Kit reads document at import time. The server owns this DOM realm;
// evaluation still uses Deno's timers, fetch, modules, and process permissions.
const window = new Window({
	url: "https://observablehq.com/",
	console,
	settings: {
		enableJavaScriptEvaluation: false,
		disableJavaScriptFileLoading: true,
		disableCSSFileLoading: true,
		disableComputedStyleRendering: true,
		navigation: {
			disableMainFrameNavigation: true,
			disableChildFrameNavigation: true,
			disableChildPageNavigation: true,
		},
	},
});
const {
	document,
	DOMParser,
	Node,
	NodeList,
	NodeFilter,
	HTMLCollection,
	Document,
	DocumentFragment,
	Text,
	Range,
	XMLSerializer,
	Element,
	HTMLElement,
	HTMLInputElement,
	HTMLSelectElement,
	HTMLTextAreaElement,
	HTMLFormElement,
	HTMLButtonElement,
	HTMLCanvasElement,
	HTMLImageElement,
	SVGElement,
	SVGSVGElement,
	Event,
	CustomEvent,
	EventTarget,
	Image,
	MutationObserver,
} = window;
Object.assign(globalThis, {
	window,
	document,
	DOMParser,
	Node,
	NodeList,
	NodeFilter,
	HTMLCollection,
	Document,
	DocumentFragment,
	Text,
	Range,
	XMLSerializer,
	Element,
	HTMLElement,
	HTMLInputElement,
	HTMLSelectElement,
	HTMLTextAreaElement,
	HTMLFormElement,
	HTMLButtonElement,
	HTMLCanvasElement,
	HTMLImageElement,
	SVGElement,
	SVGSVGElement,
	Event,
	CustomEvent,
	EventTarget,
	Image,
	MutationObserver,
	requestAnimationFrame: window.requestAnimationFrame.bind(window),
	cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
	getComputedStyle: window.getComputedStyle.bind(window),
});
console.log = console.info = console.debug = console.error.bind(console);
try {
	await import("./main");
} finally {
	await window.happyDOM.close();
}
