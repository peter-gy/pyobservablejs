import { expect, test } from "./fixture";

test("summarizes large Python readback while evaluating the complete browser table", async ({ page }) => {
	await page.goto("/?large=1");
	await expect(page.getByLabel("Large Python state", { exact: true })).toHaveText("Array(31000): 62000");
	await expect(page.getByLabel("Large uncaptured state", { exact: true })).toHaveText("None");
	await page.getByRole("button", { name: "Scale large table", exact: true }).click();
	await expect(page.getByLabel("Large Python state", { exact: true })).toHaveText("Array(31000): 93000");
	await expect(page.getByRole("region", { name: "Large uncaptured view", exact: true })).toContainText("93000");
	await expect(page.getByLabel("Large uncaptured state", { exact: true })).toHaveText("None");
});
