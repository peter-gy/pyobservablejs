import type { Notebook, NotebookTheme } from "@observablehq/notebook-kit";
import notebookPlotCss from "@observablehq/notebook-kit/plot.css?inline";
import themeAirCss from "@observablehq/notebook-kit/theme-air.css?inline";
import themeCoffeeCss from "@observablehq/notebook-kit/theme-coffee.css?inline";
import themeCottonCss from "@observablehq/notebook-kit/theme-cotton.css?inline";
import themeDeepSpaceCss from "@observablehq/notebook-kit/theme-deep-space.css?inline";
import themeGlacierCss from "@observablehq/notebook-kit/theme-glacier.css?inline";
import themeInkCss from "@observablehq/notebook-kit/theme-ink.css?inline";
import themeMidnightCss from "@observablehq/notebook-kit/theme-midnight.css?inline";
import themeNearMidnightCss from "@observablehq/notebook-kit/theme-near-midnight.css?inline";
import themeOceanFloorCss from "@observablehq/notebook-kit/theme-ocean-floor.css?inline";
import themeParchmentCss from "@observablehq/notebook-kit/theme-parchment.css?inline";
import themeSlateCss from "@observablehq/notebook-kit/theme-slate.css?inline";
import themeStarkCss from "@observablehq/notebook-kit/theme-stark.css?inline";
import themeSunFadedCss from "@observablehq/notebook-kit/theme-sun-faded.css?inline";
import plotThemeCss from "./styles/plot.css?inline";

const THEME_STYLE_ID = "pyobservablejs-notebook-kit-themes";

export const NOTEBOOK_THEMES = [
	"air",
	"coffee",
	"cotton",
	"deep-space",
	"glacier",
	"ink",
	"midnight",
	"near-midnight",
	"ocean-floor",
	"parchment",
	"slate",
	"stark",
	"sun-faded",
] as const satisfies readonly NotebookTheme[];

const THEME_CSS = {
	air: themeAirCss,
	coffee: themeCoffeeCss,
	cotton: themeCottonCss,
	"deep-space": themeDeepSpaceCss,
	glacier: themeGlacierCss,
	ink: themeInkCss,
	midnight: themeMidnightCss,
	"near-midnight": themeNearMidnightCss,
	"ocean-floor": themeOceanFloorCss,
	parchment: themeParchmentCss,
	slate: themeSlateCss,
	stark: themeStarkCss,
	"sun-faded": themeSunFadedCss,
} satisfies Record<NotebookTheme, string>;

export function installNotebookThemeStyles(root: Document | ShadowRoot = window.document): void {
	if (root.getElementById(THEME_STYLE_ID)) return;
	const document = root instanceof Document ? root : root.ownerDocument;
	const target = root instanceof Document ? root.head : root;
	const style = document.createElement("style");
	style.id = THEME_STYLE_ID;
	style.textContent = `${scopedNotebookThemeCss()}\n${notebookPlotCss.trim()}\n${plotThemeCss.trim()}`;
	target.appendChild(style);
}

export function applyNotebookTheme(root: HTMLElement, theme: Notebook["theme"]): void {
	if (typeof theme === "string") {
		root.dataset.theme = theme;
		delete root.dataset.themeLight;
		delete root.dataset.themeDark;
		return;
	}
	root.dataset.theme = "light-dark";
	root.dataset.themeLight = theme.light;
	root.dataset.themeDark = theme.dark;
}

export function scopedNotebookThemeCss(): string {
	return NOTEBOOK_THEMES.map((theme) => scopedCssForTheme(theme, THEME_CSS[theme])).join("\n");
}

function scopedCssForTheme(theme: NotebookTheme, css: string): string {
	return [
		rewriteRootSelector(css, `.pyobservablejs-notebook[data-theme="${theme}"]`),
		`@media (prefers-color-scheme: light) {\n${rewriteRootSelector(
			css,
			`.pyobservablejs-notebook[data-theme="light-dark"][data-theme-light="${theme}"]`,
		)}\n}`,
		`@media (prefers-color-scheme: dark) {\n${rewriteRootSelector(
			css,
			`.pyobservablejs-notebook[data-theme="light-dark"][data-theme-dark="${theme}"]`,
		)}\n}`,
	].join("\n");
}

function rewriteRootSelector(css: string, selector: string): string {
	return css.replace(/:root/g, selector).trim();
}
