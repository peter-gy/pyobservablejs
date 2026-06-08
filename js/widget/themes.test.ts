// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { installNotebookThemeStyles, NOTEBOOK_THEMES, scopedNotebookThemeCss } from "./themes";

describe("Notebook Kit theme styles", () => {
	test("scopes every shipped theme to the notebook root", () => {
		const css = scopedNotebookThemeCss();

		for (const theme of NOTEBOOK_THEMES) {
			expect(css).toContain(`.pyobservablejs-notebook[data-theme="${theme}"]`);
			expect(css).toContain(`[data-theme-light="${theme}"]`);
			expect(css).toContain(`[data-theme-dark="${theme}"]`);
		}
		expect(css).not.toContain(":root");
		expect(css).not.toContain("@import");
	});

	test("installs the scoped stylesheet once", () => {
		installNotebookThemeStyles(document);
		installNotebookThemeStyles(document);

		const styles = document.querySelectorAll("style#pyobservablejs-notebook-kit-themes");

		expect(styles).toHaveLength(1);
		expect(styles[0]?.textContent).toContain('.pyobservablejs-notebook[data-theme="air"]');
	});

	test("installs the scoped stylesheet inside shadow roots", () => {
		document.querySelector("style#pyobservablejs-notebook-kit-themes")?.remove();
		const host = document.createElement("div");
		const shadowRoot = host.attachShadow({ mode: "open" });

		installNotebookThemeStyles(shadowRoot);

		expect(document.querySelector("style#pyobservablejs-notebook-kit-themes")).toBeNull();
		expect(shadowRoot.querySelector("style#pyobservablejs-notebook-kit-themes")?.textContent).toContain(
			'.pyobservablejs-notebook[data-theme="air"]',
		);
	});
});
