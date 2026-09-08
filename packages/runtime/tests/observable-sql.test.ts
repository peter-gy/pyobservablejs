import { afterEach, expect, test, vi } from "vite-plus/test";
import { mountNotebook, type MountedNotebook } from "../src";
import { waitFor } from "./testing";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts.splice(0)) mount.dispose();
});

test("evaluates hosted SQL as row arrays with parameter dependencies and query invalidation", async () => {
	const calls: Array<{ query: string; params: number[]; signal: AbortSignal }> = [];
	const db = {
		queryTag(strings: readonly string[], ...params: number[]) {
			return [strings.join("?"), params];
		},
		queryStream(query: string, params: number[], { signal }: { signal: AbortSignal }) {
			calls.push({ query, params, signal });
			return {
				schema: [{ name: "value", type: "number" }],
				async *readRows() {
					yield params.map((value) => ({ value }));
				},
			};
		},
	};
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: "_sqlResult = 4", hidden: true },
				{
					id: 2,
					mode: "sql",
					output: "rows",
					database: "var:db",
					hidden: true,
					value:
						"SELECT `column`, ${(() => { const suffix = `v${shift}`; return suffix.length + _sqlResult; })()} AS value",
				},
				{ id: 3, mode: "ojs", value: "mapped = rows.map(row => row.value)", hidden: true },
			],
		},
		{ runtimeProfile: "observable", variables: { db, shift: 1 } },
	);
	mounts.push(mount);
	await waitFor(() => (mount.state.results[2]?.status === "success" && !mount.state.pending ? true : undefined));
	expect(mount.state.results[2]?.values.mapped).toEqual([6]);
	expect(calls[0]?.query).toBe("SELECT `column`, ? AS value");
	expect(calls[0]?.params).toEqual([6]);
	expect(calls[0]?.signal.aborted).toBe(false);
	mount.updateVariables({ shift: 22 });
	await waitFor(() => (calls.length === 2 && !mount.state.pending ? true : undefined));
	expect(mount.state.results[2]?.values.mapped).toEqual([7]);
	expect(calls[0]?.signal.aborted).toBe(true);
	mount.dispose();
	await waitFor(() => (calls[1]?.signal.aborted ? true : undefined));
});

test("closes an active SQL result stream when the mount is disposed", async () => {
	let started = false;
	const closed = vi.fn();
	const db = {
		queryTag(strings: readonly string[]) {
			return [strings.join("")];
		},
		queryStream(_query: string, { signal }: { signal: AbortSignal }) {
			return {
				schema: [],
				async *readRows() {
					try {
						started = true;
						await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
						yield [];
					} finally {
						closed();
					}
				},
			};
		},
	};
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "sql", value: "SELECT 1", database: "var:db", output: "rows", hidden: true }] },
		{ runtimeProfile: "observable", variables: { db } },
	);
	mounts.push(mount);
	await waitFor(() => (started ? true : undefined));
	mount.dispose();
	await waitFor(() => (closed.mock.calls.length === 1 ? true : undefined));
	expect(closed).toHaveBeenCalledOnce();
});

test("keeps authored display and view values in hidden SQL parameters for sql-only clients", async () => {
	const db = { sql: (_strings: readonly string[], ...params: number[]) => params.map((value) => ({ value })) };
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: "display = 17", hidden: true },
				{ id: 2, mode: "ojs", value: "view = 23", hidden: true },
				{ id: 3, mode: "sql", value: "SELECT ${display + view}", database: "var:db", output: "rows", hidden: true },
			],
		},
		{ runtimeProfile: "observable", variables: { db } },
	);
	mounts.push(mount);
	await waitFor(() => (mount.state.results[2]?.status === "success" && !mount.state.pending ? true : undefined));
	expect(mount.state.results[2]?.values.rows).toEqual([{ value: 40 }]);
});

test("preserves the database result identity in the Notebook Kit runtime profile", async () => {
	const result = {
		*[Symbol.iterator]() {
			yield { value: 7 };
		},
	};
	const db = { sql: () => result };
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "sql", value: "SELECT 7", database: "var:db", output: "rows", hidden: true }] },
		{ variables: { db } },
	);
	mounts.push(mount);
	await waitFor(() => (mount.state.results[0]?.status === "success" && !mount.state.pending ? true : undefined));
	expect(mount.state.results[0]?.values.rows).toBe(result);
});
