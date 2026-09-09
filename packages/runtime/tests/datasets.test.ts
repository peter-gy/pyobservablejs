import { tableFromArrays as arrow17FromArrays } from "apache-arrow-17";
import { Table, tableFromArrays, tableFromIPC, vectorFromArray, Int64, TimestampMillisecond } from "apache-arrow";
import { tableFromArrays as flechetteFromArrays, int64 } from "@uwdata/flechette";
import { expect, test, vi } from "vite-plus/test";
import { describeDataset, readDataset } from "../src/datasets";

function ipcTable(data: Awaited<ReturnType<typeof readDataset>>["data"]): Table {
	if (!(data instanceof Uint8Array)) throw new Error("Expected Arrow IPC bytes");
	return tableFromIPC(data);
}

test("describes and exports native Arrow without materializing rows", async () => {
	const table = new Table({
		id: vectorFromArray([9007199254740993n, null, 7n], new Int64()),
		day: vectorFromArray([new Date("2025-01-02"), null, new Date("2025-01-04")], new TimestampMillisecond()),
	});
	vi.spyOn(table, "toArray").mockImplementation(() => {
		throw new Error("Rows must stay columnar");
	});
	expect(describeDataset(table)).toEqual({
		kind: "arrow",
		rowCount: 3,
		schemaSource: "native",
		sampledRows: 0,
		columns: [
			{ name: "id", type: "Int64", nullable: true },
			{ name: "day", type: "Timestamp<MILLISECOND>", nullable: true },
		],
	});
	expect((await readDataset(table, { format: "native" })).data).toBe(table);
	const restored = ipcTable((await readDataset(table, { format: "arrow" })).data);
	expect(restored.getChild("id")?.get(0)).toBe(9007199254740993n);
	expect(restored.getChild("id")?.get(1)).toBeNull();
	expect(restored.getChild("day")?.get(2)).toBe(+new Date("2025-01-04"));
});

test("projects and slices Arrow while retaining types in empty exports", async () => {
	const table = tableFromArrays({ id: new BigInt64Array([3n, 5n, 8n]), label: ["a", "b", "c"] });
	const rows = await readDataset(table, { format: "rows", columns: ["id"], offset: 1, limit: 1 });
	expect(rows.data).toEqual([{ id: 5n }]);
	expect(rows.description.rowCount).toBe(1);
	const empty = ipcTable((await readDataset(table, { format: "arrow", columns: ["id"], limit: 0 })).data);
	expect(empty.numRows).toBe(0);
	expect(empty.schema.fields.map((field) => [field.name, String(field.type)])).toEqual([["id", "Int64"]]);
	expect(table.numRows).toBe(3);
});

test("exports Arrow 17 record batches with dictionaries and nested values", async () => {
	const table = arrow17FromArrays({ id: [9007199254740993n], label: ["sample"], values: [[1, 2]] });
	const restored = ipcTable((await readDataset(table.concat(table), { format: "arrow" })).data);
	expect(restored.numRows).toBe(2);
	expect(restored.getChild("id")?.get(0)).toBe(9007199254740993n);
	expect(restored.getChild("label")?.get(0)).toBe("sample");
	expect(Array.from(restored.getChild("values")?.get(1))).toEqual([1, 2]);
});

test("exports Flechette buffers directly and slices through Arrow IPC", async () => {
	const table = flechetteFromArrays(
		{ id: [9007199254740993n, 11n], label: ["a", "b"] },
		{ types: { id: int64() }, useBigInt: true },
	);
	vi.spyOn(table, "toArray").mockImplementation(() => {
		throw new Error("Rows must stay columnar");
	});
	expect((await readDataset(table, { format: "native" })).data).toBe(table);
	expect(describeDataset(table)?.schemaSource).toBe("native");
	const restored = ipcTable((await readDataset(table, { format: "arrow", columns: ["id"] })).data);
	expect(restored.getChild("id")?.get(0)).toBe(9007199254740993n);
	const sliced = ipcTable((await readDataset(table, { format: "arrow", offset: 1, limit: 1 })).data);
	expect(sliced.numRows).toBe(1);
	expect(sliced.getChild("id")?.get(0)).toBe(11n);
	expect(sliced.getChild("label")?.get(0)).toBe("b");
});

test("reads classic SQL row arrays backed by native Arrow row proxies", async () => {
	const table = arrow17FromArrays({ id: [9007199254740993n, 5n], label: ["a", "b"] });
	const rows = Object.assign(table.toArray(), { schema: table.schema });
	expect(describeDataset(rows)?.kind).toBe("rows");
	expect(describeDataset(rows)?.schemaSource).toBe("native");
	expect((await readDataset(rows, { format: "rows", columns: ["id"], offset: 1 })).data).toEqual([{ id: 5n }]);
	const restored = ipcTable((await readDataset(rows, { format: "arrow" })).data);
	expect(restored.getChild("id")?.get(0)).toBe(9007199254740993n);
	expect(restored.getChild("label")?.get(1)).toBe("b");
	expect(describeDataset(table.toArray())?.columns.map((column) => column.name)).toEqual(["id", "label"]);
	const empty = ipcTable((await readDataset(rows, { format: "arrow", limit: 0 })).data);
	expect(empty.schema.fields.map((field) => String(field.type))).toEqual(["Int64", "Dictionary<Int32, Utf8>"]);
});

test("samples discovery but retains fields beyond the sample in explicit reads", async () => {
	const rows = [...Array.from({ length: 100 }, (_, value) => ({ value })), { value: 100, extra: "kept" }];
	const info = describeDataset(rows);
	expect(info?.sampledRows).toBe(100);
	expect(info?.columns.map((column) => column.name)).toEqual(["value"]);
	expect((await readDataset(rows, { format: "native" })).data).toBe(rows);
	const result = await readDataset(rows, { format: "rows", offset: 100 });
	expect(result.data).toEqual([{ value: 100, extra: "kept" }]);
	const table = ipcTable((await readDataset(rows, { format: "arrow" })).data);
	expect(table.getChild("extra")?.get(100)).toBe("kept");
	expect(table.getChild("extra")?.get(0)).toBeNull();
});

test("discovers stored columns across rows with accessors", () => {
	const getter = vi.fn(() => 99);
	const first = Object.defineProperty({ name: "first" }, "amount", { get: getter, enumerable: true });
	const second = Object.defineProperty({ name: "second", amount: 7 }, "lazy", { get: getter, enumerable: true });
	expect(describeDataset([first, second])?.columns).toEqual([
		{ name: "name", type: "string", nullable: false },
		{ name: "amount", type: "number", nullable: true },
	]);
	expect(getter).not.toHaveBeenCalled();
});

test("reads fields added and removed from mutable rows", async () => {
	const row = { amount: 2 };
	const rows = [row];
	const initial = describeDataset(rows);
	Object.assign(row, { label: "current" });
	expect((await readDataset(rows, { format: "rows" })).data).toEqual([{ amount: 2, label: "current" }]);
	Reflect.deleteProperty(row, "label");
	expect((await readDataset(rows, { format: "rows" })).data).toEqual([{ amount: 2 }]);
	expect(initial?.columns).toEqual([{ name: "amount", type: "number", nullable: false }]);
});

test("converts scalar arrays and preserves declared schemas for empty rows", async () => {
	const values = [3n, null, 5n];
	expect(describeDataset(values)?.kind).toBe("array");
	expect((await readDataset(values, { format: "rows", offset: 1 })).data).toEqual([{ value: null }, { value: 5n }]);
	const scalar = ipcTable((await readDataset(values, { format: "arrow" })).data);
	expect(scalar.getChild("value")?.get(2)).toBe(5n);
	const empty = Object.assign([], { schema: [{ name: "amount", type: "number", nullable: false }] });
	const result = await readDataset(empty, { format: "arrow" });
	expect(result.description.columns).toEqual([{ name: "amount", type: "number", nullable: false }]);
	expect(ipcTable(result.data).schema.fields.map((field) => [field.name, String(field.type)])).toEqual([
		["amount", "Float64"],
	]);
	expect(ipcTable(result.data).schema.fields[0]?.nullable).toBe(false);
	const sliced = await readDataset([{ amount: 2 }], { format: "arrow", limit: 0 });
	expect(ipcTable(sliced.data).schema.fields.map((field) => String(field.type))).toEqual(["Float64"]);
});

test("rejects omitted properties in explicit reads and permits intentional projections", async () => {
	const getter = vi.fn(() => {
		throw new Error("Getter must not run");
	});
	const row = Object.defineProperty({ amount: 2 }, "lazy", { get: getter, enumerable: true });
	expect(describeDataset([row])?.columns.map((column) => column.name)).toEqual(["amount"]);
	const source = [row];
	expect((await readDataset(source, { format: "native" })).data).toBe(source);
	await expect(readDataset(source, { format: "rows" })).rejects.toThrow("accessor");
	await expect(readDataset(source, { format: "arrow" })).rejects.toThrow("accessor");
	expect((await readDataset(source, { format: "rows", columns: ["amount"] })).data).toEqual([{ amount: 2 }]);
	const symbolRow = { amount: 2, [Symbol("field")]: 3 };
	await expect(readDataset([symbolRow], { format: "arrow" })).rejects.toThrow("symbol");
	expect(getter).not.toHaveBeenCalled();
	await expect(readDataset([row], { format: "rows", columns: ["missing"] })).rejects.toThrow("Unknown dataset column");
	await expect(readDataset([row], { format: "rows", offset: -1 })).rejects.toThrow("offset");
	await expect(readDataset([row], { format: "rows", limit: 0.5 })).rejects.toThrow("limit");
});

test("preserves counts for zero-column Arrow record batches", async () => {
	const result = await readDataset([{}, {}], { format: "arrow" });
	expect(result.description.rowCount).toBe(2);
	expect(ipcTable(result.data).numRows).toBe(2);
	expect(ipcTable(result.data).numCols).toBe(0);
});

test("preserves unsigned 64-bit values and rejects wider BigInts", async () => {
	const result = await readDataset([1n << 63n], { format: "arrow" });
	expect(ipcTable(result.data).getChild("value")?.get(0)).toBe(1n << 63n);
	await expect(readDataset([1n << 64n], { format: "arrow" })).rejects.toThrow("64-bit");
	await expect(readDataset([-1n, 1n << 63n], { format: "arrow" })).rejects.toThrow("64-bit");
});

test("keeps Float32 views native and preserves their element type through Arrow", async () => {
	const backing = new Float32Array([9, 1.25, 2.5, 3.75, 9]);
	const values = backing.subarray(1, 4);
	expect(describeDataset(values)).toEqual({
		kind: "array",
		rowCount: 3,
		columns: [{ name: "value", type: "Float32", nullable: false }],
		schemaSource: "native",
		sampledRows: 0,
	});
	expect((await readDataset(values, { format: "native" })).data).toBe(values);
	const sliced = (await readDataset(values, { format: "native", offset: 1, limit: 1 })).data;
	expect(sliced).toBeInstanceOf(Float32Array);
	if (!(sliced instanceof Float32Array)) throw new Error("Expected native float array");
	expect(sliced.buffer).toBe(values.buffer);
	expect(Array.from(sliced)).toEqual([2.5]);
	const table = ipcTable((await readDataset(values, { format: "arrow", columns: ["value"] })).data);
	expect(String(table.schema.fields[0]?.type)).toBe("Float32");
	expect(Array.from(table.getChild("value")!)).toEqual([1.25, 2.5, 3.75]);
});

test("reads integer typed arrays exactly and excludes DataView", async () => {
	const values = new BigInt64Array([9007199254740993n, -2n]);
	expect((await readDataset(values, { format: "rows", offset: 1 })).data).toEqual([{ value: -2n }]);
	const table = ipcTable((await readDataset(values, { format: "arrow" })).data);
	expect(String(table.schema.fields[0]?.type)).toBe("Int64");
	expect(table.getChild("value")?.get(0)).toBe(9007199254740993n);
	const empty = ipcTable((await readDataset(new Int32Array([2]), { format: "arrow", limit: 0 })).data);
	expect(empty.numRows).toBe(0);
	expect(String(empty.schema.fields[0]?.type)).toBe("Int32");
	expect(describeDataset(new DataView(new ArrayBuffer(8)))).toBeNull();
});

test("classifies opaque values without invoking protocol getters", async () => {
	const getter = vi.fn(() => {
		throw new Error("Getter must not run");
	});
	const value = Object.defineProperties(
		{},
		{
			schema: { get: getter },
			numRows: { get: getter },
			objects: { get: getter },
			[Symbol.toStringTag]: { get: getter },
		},
	);
	expect(describeDataset(value)).toBeNull();
	await expect(readDataset(value, { format: "native" })).rejects.toThrow("not a supported dataset");
	const partialArrow = Object.defineProperties(
		{ schema: { fields: [] }, getChild() {}, get() {}, select() {} },
		{
			toArray: { get: getter },
			numRows: { get: getter },
		},
	);
	expect(describeDataset(partialArrow)).toBeNull();
	const partialArquero = Object.defineProperty(
		{
			numRows() {
				return 1;
			},
			columnNames() {
				return ["x"];
			},
			select() {},
			slice() {},
			ungroup() {},
		},
		"objects",
		{ get: getter },
	);
	expect(describeDataset(partialArquero)).toBeNull();
	expect(getter).not.toHaveBeenCalled();
});

test("ignores accessor metadata and opaque sample entries during discovery", async () => {
	const getter = vi.fn(() => {
		throw new Error("Getter must not run");
	});
	const rows = Object.defineProperties([{ x: 1 }], { schema: { get: getter }, columns: { get: getter } });
	expect(describeDataset(rows)?.columns.map((column) => column.name)).toEqual(["x"]);
	expect((await readDataset(rows, { format: "native" })).data).toBe(rows);
	const nestedMetadata = Object.assign([{ x: 1 }], { schema: Object.defineProperty({}, "fields", { get: getter }) });
	expect(describeDataset(nestedMetadata)?.schemaSource).toBe("sampled");
	const opaqueRows = Object.defineProperty([1], "0", { get: getter });
	expect(describeDataset(opaqueRows)).toBeNull();
	const taggedRow = Object.defineProperty({}, Symbol.toStringTag, { get: getter });
	expect(describeDataset([taggedRow])).toBeNull();
	expect(getter).not.toHaveBeenCalled();
});
