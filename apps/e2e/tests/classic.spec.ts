import { expect, test } from "./fixture";

test("loads classic libraries across independently bundled widget views", async ({ page }) => {
	await page.route("https://example.test/amd-controls.js", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: `define([], () => ({
				range([min, max], {value, label}) {
					const input = document.createElement("input");
					input.type = "range";
					input.min = min;
					input.max = max;
					input.value = value;
					input.setAttribute("aria-label", label);
					return input;
				}
			}));`,
		}),
	);
	await page.route("https://example.test/amd-factor.js", (route) =>
		route.fulfill({ contentType: "application/javascript", body: "define([], () => 3);" }),
	);
	await page.goto("/?classic=1");
	await expect(page.getByLabel(/^Classic Python state /)).toHaveText(["6", "6", "6", "6"]);
	await page.getByRole("region", { name: "Classic view 0", exact: true }).getByRole("slider").press("End");
	await expect(page.getByLabel(/^Classic Python state /)).toHaveText(["30", "30", "30", "30"]);
});
