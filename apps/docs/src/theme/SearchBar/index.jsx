import useBaseUrl from "@docusaurus/useBaseUrl";
import SearchBar from "@theme-original/SearchBar";
import { useEffect } from "react";

function syncColorMode() {
	const colorMode = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
	for (const element of document.querySelectorAll("orama-search-button, orama-search-box")) {
		if (element.colorScheme !== colorMode) {
			element.colorScheme = colorMode;
		}
	}
}

function focusSearchButton() {
	document.querySelector("orama-search-button")?.shadowRoot?.querySelector("orama-button button")?.focus();
}

function syncFooterLogo(root, logos) {
	const footer = root.querySelector("orama-footer");
	const logo = footer?.querySelector("img.logo");
	if (!footer || !logo) {
		return;
	}

	const src = footer.colorScheme === "dark" ? logos.dark : logos.light;
	if (logo.getAttribute("src") !== src) {
		logo.src = src;
		logo.alt = "Orama";
	}
}

export default function SearchBarWithLocalFooter() {
	const lightLogo = useBaseUrl("/img/orama/orama-when-light.svg");
	const darkLogo = useBaseUrl("/img/orama/orama-when-dark.svg");

	useEffect(() => {
		let attempts = 0;
		let observer;
		let searchBox;
		let themeObserver;
		let timeout;

		function connect() {
			searchBox = document.querySelector("orama-search-box");
			const root = searchBox?.shadowRoot;
			if (!root) {
				attempts += 1;
				if (attempts < 100) {
					timeout = window.setTimeout(connect, 50);
				}
				return;
			}

			// Orama's footer image points to an external asset host from inside
			// the search box shadow root, so page styles and markup cannot replace it.
			const logos = { light: lightLogo, dark: darkLogo };
			const sync = () => {
				syncColorMode();
				syncFooterLogo(root, logos);
			};
			observer = new MutationObserver(sync);
			observer.observe(root, {
				attributes: true,
				attributeFilter: ["color-scheme", "src"],
				childList: true,
				subtree: true,
			});
			themeObserver = new MutationObserver(sync);
			themeObserver.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["data-theme"],
			});
			searchBox.addEventListener("modalClosed", focusSearchButton);
			sync();
		}

		connect();
		return () => {
			window.clearTimeout(timeout);
			observer?.disconnect();
			searchBox?.removeEventListener("modalClosed", focusSearchButton);
			themeObserver?.disconnect();
		};
	}, [darkLogo, lightLogo]);

	return <SearchBar />;
}
