import type { Cell } from "@observablehq/notebook-kit";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import markdown from "@shikijs/langs/markdown";
import sql from "@shikijs/langs/sql";
import typescript from "@shikijs/langs/typescript";
import githubLightDefault from "@shikijs/themes/github-light-default";
import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { HighlighterCore, ThemedToken } from "@shikijs/types";

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

export function renderSource(cell: Cell, signal: AbortSignal): HTMLElement {
	const sourceMode = SOURCE_MODE_BY_CELL_MODE[cell.mode];
	const panel = document.createElement("div");
	panel.className = "observablejs-source-panel";

	const label = document.createElement("span");
	label.className = "observablejs-source-label";
	label.textContent = sourceMode.label;

	const pre = document.createElement("pre");
	pre.className = "observablejs-source";
	pre.tabIndex = 0;
	pre.dataset.highlight = "pending";
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
	const sourceMode = SOURCE_MODE_BY_CELL_MODE[cell.mode];
	if (!sourceMode.language || cell.value.length > MAX_HIGHLIGHT_CHARS || signal.aborted) {
		pre.dataset.highlight = "plain";
		return;
	}

	try {
		const highlighted = await getHighlightedSource(cell.value, sourceMode.language);
		if (signal.aborted) return;
		renderTokenLines(code, highlighted.tokens);
		if (highlighted.background) pre.style.setProperty("--observablejs-source-bg", highlighted.background);
		if (highlighted.color) pre.style.setProperty("--observablejs-source-color", highlighted.color);
		pre.dataset.highlight = "ready";
	} catch {
		if (!signal.aborted) pre.dataset.highlight = "plain";
	}
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
		highlighterPromise = createHighlighterCore({
			engine: createJavaScriptRegexEngine(),
			langs: [html, javascript, markdown, sql, typescript],
			themes: [githubLightDefault],
		}).catch((error) => {
			highlighterPromise = undefined;
			throw error;
		});
	}
	return highlighterPromise;
}

function renderTokenLines(code: HTMLElement, lines: ThemedToken[][]): void {
	code.replaceChildren();
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		if (lineIndex > 0) code.appendChild(document.createTextNode("\n"));
		const line = document.createElement("span");
		line.className = "observablejs-source-line";
		for (const token of lines[lineIndex] ?? []) line.appendChild(renderToken(token));
		code.appendChild(line);
	}
}

function renderToken(token: ThemedToken): Text | HTMLSpanElement {
	if (!token.color && !token.bgColor && token.fontStyle == null && !token.htmlStyle) {
		return document.createTextNode(token.content);
	}
	const span = document.createElement("span");
	span.className = "observablejs-source-token";
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
