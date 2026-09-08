import { expect, test } from "./fixture";

test("imports SQL row arrays with visible, hidden, and anonymous results", async ({ page }) => {
	await page.goto("/?sql=1");
	const report = page.getByLabel("SQL Python state", { exact: true });
	await expect(report).toHaveText("total=85 hidden=12 anonymous=success");
	const tables = page.getByRole("region", { name: "SQL view", exact: true }).getByRole("table");
	await expect(tables).toHaveCount(2);
	await expect(tables.first().getByRole("cell", { name: "42", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Change SQL parameter", exact: true }).click();
	await expect(report).toHaveText("total=89 hidden=14 anonymous=success");
	await expect(tables).toHaveCount(2);
	await expect(tables.first().getByRole("cell", { name: "44", exact: true })).toBeVisible();
});
