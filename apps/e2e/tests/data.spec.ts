import { expect, test } from "./fixture";

test("reads hidden browser data through Python background tasks while capture is disabled", async ({ page }) => {
	await page.goto("/?data=1");
	await expect(page.getByLabel("Data Python result", { exact: true })).toHaveText(
		"cells=5 hidden=True rows=3 source=sampled arrow=2 sum=10 total=12 bytes=00ff616263 timeout=True capture=None",
	);
	await expect(page.getByLabel("Data metadata", { exact: true })).toHaveText("cells=5 datasets=1 capture=None");
	const view = page.getByRole("region", { name: "Data view", exact: true });
	await expect(view).toContainText("12");
	await page.getByRole("button", { name: "Update data", exact: true }).click();
	await expect(view).toContainText("18");
	await page.getByRole("button", { name: "Read updated data", exact: true }).click();
	await expect(page.getByLabel("Updated data result", { exact: true })).toHaveText("stale=True sum=9");
});
