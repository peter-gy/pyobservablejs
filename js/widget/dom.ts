import type { Cell, Notebook } from "@observablehq/notebook-kit";
import type { HighlighterCore, ThemedToken } from "@shikijs/core";
import { applyNotebookTheme } from "./themes";

export const CLASS_NAMES = {
	widget: "pyobservablejs",
	notebook: "pyobservablejs-notebook",
	cell: "pyobservablejs-cell",
	error: "pyobservablejs-error",
	sourcePanel: "pyobservablejs-source-panel",
	sourceLabel: "pyobservablejs-source-label",
	source: "pyobservablejs-source",
	sourceLine: "pyobservablejs-source-line",
	sourceToken: "pyobservablejs-source-token",
} as const;

export const DATASET_KEYS = {
	composed: "pyobservablejsComposed",
	cellRef: "pyobservablejsCellRef",
	sourceHighlight: "pyobservablejsSourceHighlight",
} as const;

export const DATA_ATTRIBUTES = {
	composed: "data-pyobservablejs-composed",
	cellRef: "data-pyobservablejs-cell-ref",
	sourceHighlight: "data-pyobservablejs-source-highlight",
} as const;

export const CSS_VARIABLES = {
	sourceBackground: "--pyobservablejs-source-bg",
	sourceColor: "--pyobservablejs-source-color",
} as const;

type HighlightLanguage = "html" | "javascript" | "markdown" | "sql" | "typescript";

type HighlightResult = {
	tokens: ThemedToken[][];
	background?: string;
	color?: string;
};

type SourceMode = {
	label: string;
	language: HighlightLanguage | null;
};

const SHIKI_THEME = "github-light-default";
// Very large pinned cells render as plain text to keep widget updates responsive.
const MAX_HIGHLIGHT_CHARS = 120_000;
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

const SOURCE_MODE_BY_CELL_MODE = {
	dot: { label: "DOT", language: null },
	html: { label: "HTML", language: "html" },
	js: { label: "JavaScript", language: "javascript" },
	md: { label: "Markdown", language: "markdown" },
	node: { label: "Node.js", language: "javascript" },
	ojs: { label: "OJS", language: "javascript" },
	python: { label: "Python", language: null },
	r: { label: "R", language: null },
	sql: { label: "SQL", language: "sql" },
	tex: { label: "TeX", language: null },
	ts: { label: "TypeScript", language: "typescript" },
} satisfies Record<Cell["mode"], SourceMode>;

let highlighterPromise: Promise<HighlighterCore> | undefined;

export function markWidgetShell(el: HTMLElement): void {
	el.classList.add(CLASS_NAMES.widget);
}

export function prepareWidgetShell(el: HTMLElement): void {
	el.replaceChildren();
	markWidgetShell(el);
}

export function createNotebookRoot(parent: HTMLElement, theme: Notebook["theme"]): HTMLElement {
	const root = document.createElement("div");
	root.className = `${CLASS_NAMES.notebook} observablehq observablehq-root observablehq--block`;
	applyNotebookTheme(root, theme);
	parent.appendChild(root);
	return root;
}

export function appendCellWrapper(root: HTMLElement, options: { composedCellRef?: string } = {}): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = CLASS_NAMES.cell;
	if (options.composedCellRef !== undefined) {
		wrapper.dataset[DATASET_KEYS.composed] = "true";
		wrapper.dataset[DATASET_KEYS.cellRef] = options.composedCellRef;
	}
	root.appendChild(wrapper);
	return wrapper;
}

export function createCellOutput(wrapper: HTMLElement, cell: Cell): HTMLDivElement {
	const output = document.createElement("div");
	output.id = `cell-${cell.id}`;
	output.className = "observablehq observablehq--cell";
	wrapper.appendChild(output);
	return output;
}

export function createTopLevelError(error: unknown): HTMLElement {
	const pre = document.createElement("pre");
	pre.className = CLASS_NAMES.error;
	pre.setAttribute("role", "alert");
	pre.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return pre;
}

export function renderSource(cell: Cell, signal: AbortSignal): HTMLElement {
	const sourceMode = SOURCE_MODE_BY_CELL_MODE[cell.mode];
	const panel = document.createElement("div");
	panel.className = CLASS_NAMES.sourcePanel;

	const label = document.createElement("span");
	label.className = CLASS_NAMES.sourceLabel;
	label.textContent = sourceMode.label;

	const pre = document.createElement("pre");
	pre.className = CLASS_NAMES.source;
	pre.tabIndex = 0;
	pre.dataset[DATASET_KEYS.sourceHighlight] = "pending";
	pre.setAttribute("aria-label", `${sourceMode.label} source`);
	const code = document.createElement("code");
	code.className = `language-${sourceMode.language ?? cell.mode}`;
	code.textContent = cell.value;
	pre.appendChild(code);
	panel.append(pre, label);

	void highlightSource(cell, pre, code, signal);
	return panel;
}

async function highlightSource(cell: Cell, pre: HTMLPreElement, code: HTMLElement, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		pre.dataset[DATASET_KEYS.sourceHighlight] = "plain";
		return;
	}

	try {
		const highlighted = await highlightSourceText(cell.value, cell.mode);
		if (signal.aborted) return;
		if (!highlighted) {
			pre.dataset[DATASET_KEYS.sourceHighlight] = "plain";
			return;
		}
		renderTokenLines(code, highlighted.tokens);
		if (highlighted.background) pre.style.setProperty(CSS_VARIABLES.sourceBackground, highlighted.background);
		if (highlighted.color) pre.style.setProperty(CSS_VARIABLES.sourceColor, highlighted.color);
		pre.dataset[DATASET_KEYS.sourceHighlight] = "ready";
	} catch {
		if (!signal.aborted) pre.dataset[DATASET_KEYS.sourceHighlight] = "plain";
	}
}

function highlightSourceText(source: string, mode: Cell["mode"]): Promise<HighlightResult | null> {
	const sourceMode = SOURCE_MODE_BY_CELL_MODE[mode];
	if (!sourceMode.language || source.length > MAX_HIGHLIGHT_CHARS) return Promise.resolve(null);
	return getHighlightedSource(source, sourceMode.language);
}

function getHighlightedSource(source: string, language: HighlightLanguage): Promise<HighlightResult> {
	return getHighlighter().then((highlighter) => {
		const result = highlighter.codeToTokens(source, {
			lang: language,
			theme: SHIKI_THEME,
		});
		return {
			tokens: result.tokens,
			background: result.bg,
			color: result.fg,
		};
	});
}

function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter().catch((error) => {
			highlighterPromise = undefined;
			throw error;
		});
	}
	return highlighterPromise;
}

async function createHighlighter(): Promise<HighlighterCore> {
	const [
		{ createHighlighterCore },
		{ createJavaScriptRegexEngine },
		{ default: html },
		{ default: javascript },
		{ default: markdown },
		{ default: sql },
		{ default: typescript },
		{ default: githubLightDefault },
	] = await Promise.all([
		import("@shikijs/core"),
		import("@shikijs/engine-javascript"),
		import("@shikijs/langs/html"),
		import("@shikijs/langs/javascript"),
		import("@shikijs/langs/markdown"),
		import("@shikijs/langs/sql"),
		import("@shikijs/langs/typescript"),
		import("@shikijs/themes/github-light-default"),
	]);
	return createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		langs: [html, javascript, markdown, sql, typescript],
		themes: [githubLightDefault],
	});
}

function renderTokenLines(code: HTMLElement, lines: ThemedToken[][]): void {
	code.replaceChildren();
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		if (lineIndex > 0) code.appendChild(document.createTextNode("\n"));
		const line = document.createElement("span");
		line.className = CLASS_NAMES.sourceLine;
		for (const token of lines[lineIndex] ?? []) line.appendChild(renderToken(token));
		code.appendChild(line);
	}
}

function renderToken(token: ThemedToken): Text | HTMLSpanElement {
	if (!token.color && !token.bgColor && token.fontStyle == null && !token.htmlStyle) {
		return document.createTextNode(token.content);
	}
	const span = document.createElement("span");
	span.className = CLASS_NAMES.sourceToken;
	span.textContent = token.content;
	if (token.color) span.style.color = token.color;
	if (token.bgColor) span.style.backgroundColor = token.bgColor;
	if (token.fontStyle != null) applyFontStyle(span, token.fontStyle);
	if (token.htmlStyle) {
		for (const [name, value] of Object.entries(token.htmlStyle)) span.style.setProperty(name, value);
	}
	return span;
}

function applyFontStyle(span: HTMLSpanElement, fontStyle: number): void {
	if (fontStyle & FONT_STYLE_ITALIC) span.style.fontStyle = "italic";
	if (fontStyle & FONT_STYLE_BOLD) span.style.fontWeight = "600";
	if (fontStyle & FONT_STYLE_UNDERLINE) span.style.textDecorationLine = "underline";
	if (fontStyle & FONT_STYLE_STRIKETHROUGH) {
		span.style.textDecorationLine = span.style.textDecorationLine
			? `${span.style.textDecorationLine} line-through`
			: "line-through";
	}
}
