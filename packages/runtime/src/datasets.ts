import type { Schema } from "apache-arrow";
import type { BigIntArray, TypedArray } from "apache-arrow/interfaces";
import {
	isArrowDataset,
	isNativeField,
	arrowBytes,
	apacheTable,
	arrowSchema,
	dataProperty,
	propertyDescriptor,
	dataArray,
	type NativeField,
} from "./arrow";
import { isBigInt, isBoolean, isCallable, isNumber, isObjectValue, isString, javaScriptKind } from "./value-kind";
import type { RuntimeValue } from "./values";

export type ColumnInfo = Readonly<{ name: string; type: string; nullable: boolean | null }>;
export type DatasetDescription = Readonly<{
	kind: "arrow" | "arquero" | "rows" | "array";
	rowCount: number;
	columns: readonly ColumnInfo[];
	schemaSource: "native" | "sampled";
	sampledRows: number;
}>;
export type DatasetReadOptions = {
	format: "native" | "rows" | "arrow";
	columns?: readonly string[];
	offset?: number;
	limit?: number;
};
export type DatasetRead = {
	data: RuntimeValue | Uint8Array;
	description: DatasetDescription;
	format: DatasetReadOptions["format"];
};

interface ArqueroDataset {
	numRows(): number;
	columnNames(): string[];
	objects(options?: { limit?: number; offset?: number; columns?: string[] }): object[];
	select(...columns: string[]): ArqueroDataset;
	ungroup(): ArqueroDataset;
	slice(start: number, end: number): ArqueroDataset;
	toArrowIPC?(): Uint8Array;
	toArrowBuffer?(): ArrayBuffer | Uint8Array;
}
type Row = Record<string, RuntimeValue>;
type TypeFormatter = (this: RuntimeValue) => RuntimeValue;
type NumericArray = TypedArray | BigIntArray;
const NUMERIC_ARRAYS = {
	Int8Array: { constructor: Int8Array, type: "Int8" },
	Int16Array: { constructor: Int16Array, type: "Int16" },
	Int32Array: { constructor: Int32Array, type: "Int32" },
	Uint8Array: { constructor: Uint8Array, type: "Uint8" },
	Uint8ClampedArray: { constructor: Uint8ClampedArray, type: "Uint8" },
	Uint16Array: { constructor: Uint16Array, type: "Uint16" },
	Uint32Array: { constructor: Uint32Array, type: "Uint32" },
	Float32Array: { constructor: Float32Array, type: "Float32" },
	Float64Array: { constructor: Float64Array, type: "Float64" },
	BigInt64Array: { constructor: BigInt64Array, type: "Int64" },
	BigUint64Array: { constructor: BigUint64Array, type: "Uint64" },
} as const;
const SAMPLE_ROWS = 100;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;

export function describeDataset(value: RuntimeValue): DatasetDescription | null {
	try {
		return describeValue(value);
	} catch {
		return null;
	}
}

function describeValue(value: RuntimeValue): DatasetDescription | null {
	if (isArrowDataset(value)) {
		const fields = dataArray(dataProperty(dataProperty(value, "schema"), "fields"));
		if (!fields?.every(isNativeField)) return null;
		return description("arrow", value.numRows, nativeColumns(fields), "native", 0);
	}
	if (isArqueroDataset(value)) {
		const sample = value.objects({ limit: SAMPLE_ROWS });
		return description("arquero", value.numRows(), inferColumns(sample, value.columnNames()), "sampled", sample.length);
	}
	if (isNumericArray(value)) {
		const type = NUMERIC_ARRAYS[numericArrayName(value)!].type;
		const length = typedArrayLength?.call(value);
		if (!isNumber(length)) return null;
		return description("array", length, [{ name: "value", type, nullable: false }], "native", 0);
	}
	if (!Array.isArray(value)) return null;
	const length = dataProperty(value, "length");
	if (!isNumber(length)) return null;
	const schema = arraySchema(value);
	const sample = dataArray(value, SAMPLE_ROWS);
	if (!sample) return null;
	if (schema || (sample.length > 0 && sample.every(isRow))) {
		return description(
			"rows",
			length,
			schema ?? inferColumns(sample),
			schema ? "native" : "sampled",
			schema ? 0 : sample.length,
		);
	}
	if (sample.some((item) => !isScalar(item))) return null;
	return description("array", length, [inferColumn("value", sample)], "sampled", sample.length);
}

export async function readDataset(value: RuntimeValue, options: DatasetReadOptions): Promise<DatasetRead> {
	if (!["native", "rows", "arrow"].includes(options.format))
		throw new TypeError(`Unsupported dataset format: ${options.format}`);
	const initial = describeDataset(value);
	if (!initial) throw new TypeError("Value is not a supported dataset");
	const offset = nonnegativeIndex(options.offset ?? 0, "offset");
	const limit = options.limit === undefined ? undefined : nonnegativeIndex(options.limit, "limit");
	const end = limit === undefined ? initial.rowCount : Math.min(initial.rowCount, offset + limit);
	const unchanged = options.columns === undefined && offset === 0 && limit === undefined;
	if (options.format === "native" && unchanged) return { data: value, description: initial, format: "native" };
	const selectedRows = Array.isArray(value) ? value.slice(offset, end) : [];
	if (initial.kind === "rows" && selectedRows.some((row) => !isRow(row))) {
		throw new TypeError("Row datasets must contain objects");
	}
	if (initial.kind === "rows" && (options.format !== "native" || options.columns)) {
		validateRowProperties(selectedRows, options.columns);
	}
	const available =
		initial.kind === "rows" && initial.schemaSource === "sampled"
			? inferColumns(selectedRows.slice(0, SAMPLE_ROWS), [
					...new Set([...initial.columns.map((column) => column.name), ...rowNames(selectedRows)]),
				]).map((column) =>
					column.type === "unknown"
						? {
								...column,
								type: initial.columns.find((item) => item.name === column.name)?.type ?? column.type,
							}
						: column,
				)
			: initial.columns;
	const columns = options.columns ? [...options.columns] : available.map((column) => column.name);
	if (options.columns && columns.length === 0) throw new TypeError("columns must contain at least one column name");
	if (new Set(columns).size !== columns.length && (options.columns || options.format === "rows")) {
		throw new TypeError("Row projections require unique column names");
	}
	for (const column of columns) {
		if (!available.some(({ name }) => name === column)) throw new RangeError(`Unknown dataset column: ${column}`);
	}
	const rowCount = Math.max(0, end - Math.min(offset, initial.rowCount));
	const projected = Object.freeze({
		...initial,
		rowCount,
		columns: Object.freeze(
			(options.columns ? columns.map((name) => available.find((column) => column.name === name)!) : available).map(
				(column) => Object.freeze({ ...column }),
			),
		),
	});
	if (isNumericArray(value)) {
		const selected = offset === 0 && limit === undefined ? value : value.subarray(offset, end);
		if (options.format === "native") return { data: selected, description: projected, format: "native" };
		if (options.format === "rows") {
			return {
				data: Array.from<number | bigint, Row>(selected, (value) => ({ value })),
				description: projected,
				format: "rows",
			};
		}
		const arrow = await import("apache-arrow");
		const { constructor } = NUMERIC_ARRAYS[numericArrayName(selected)!];
		// SAFETY: Native typed-array constructors accept ArrayBuffer and SharedArrayBuffer storage.
		const native = new constructor(selected.buffer as ArrayBuffer, selected.byteOffset, selected.length);
		return {
			data: arrow.tableToIPC(arrow.tableFromArrays({ value: native })),
			description: projected,
			format: "arrow",
		};
	}
	if (isArrowDataset(value)) {
		let table = options.columns ? value.select(columns) : value;
		if (offset !== 0 || limit !== undefined) table = (await apacheTable(table)).slice(offset, end);
		if (options.format === "native") return { data: table, description: projected, format: "native" };
		if (options.format === "arrow") return { data: await arrowBytes(table), description: projected, format: "arrow" };
		const rows = Array.from({ length: table.numRows }, (_, index) =>
			Object.fromEntries(columns.map((name) => [name, table.getChild(name)?.get(index)])),
		);
		return { data: rows, description: projected, format: "rows" };
	}
	if (isArqueroDataset(value)) {
		let table = options.columns ? value.select(...columns) : value;
		if (offset !== 0 || limit !== undefined) table = table.ungroup().slice(offset, end);
		if (options.format === "native") return { data: table, description: projected, format: "native" };
		if (options.format === "arrow") {
			const bytes = table.toArrowIPC?.() ?? table.toArrowBuffer?.();
			if (!bytes) throw new TypeError("Arquero dataset does not provide Arrow IPC export");
			return {
				data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
				description: projected,
				format: "arrow",
			};
		}
		return { data: table.objects().map((row) => selectRow(row, columns)), description: projected, format: "rows" };
	}
	if (!Array.isArray(value)) throw new TypeError("Value is not a supported dataset");
	const sliced = selectedRows;
	const rows: Row[] = sliced.map((row) => (initial.kind === "array" ? { value: row } : selectRow(row, columns)));
	if (options.format === "arrow") {
		const arrow = await import("apache-arrow");
		const sourceSchema = nativeArraySchema(value);
		const nativeSchema = sourceSchema ? await arrowSchema(sourceSchema) : undefined;
		const vectors = Object.fromEntries(
			projected.columns.map((column) => {
				const values = rows.map((row) => row[column.name] ?? null);
				const type =
					nativeSchema?.fields.find((field) => field.name === column.name)?.type ??
					(values.some((entry) => entry !== null && entry !== undefined)
						? integerType(values, arrow)
						: emptyColumnType(column.type, arrow));
				return [column.name, type ? arrow.vectorFromArray(values, type) : arrow.vectorFromArray(values)];
			}),
		);
		let table = new arrow.Table(vectors);
		if (projected.columns.length === 0 && rows.length > 0) {
			const schema = new arrow.Schema([]);
			table = new arrow.Table(
				new arrow.RecordBatch(
					schema,
					arrow.makeData({
						type: new arrow.Struct([]),
						length: rows.length,
						children: [],
						nullCount: 0,
					}),
				),
			);
		}
		const schema = new arrow.Schema(
			table.schema.fields.map(
				(field, index) =>
					nativeSchema?.fields.find((item) => item.name === field.name) ??
					field.clone({
						nullable: projected.columns[index]?.nullable ?? field.nullable,
					}),
			),
			nativeSchema?.metadata,
		);
		const typed = new arrow.Table(
			schema,
			table.batches.map((batch) => new arrow.RecordBatch(schema, batch.data)),
		);
		return { data: arrow.tableToIPC(typed), description: projected, format: "arrow" };
	}
	const data = options.format === "native" && options.columns === undefined ? sliced : rows;
	return { data, description: projected, format: options.format };
}

function numericArrayName(value: RuntimeValue): keyof typeof NUMERIC_ARRAYS | null {
	if (!ArrayBuffer.isView(value)) return null;
	const name = typedArrayName?.call(value);
	return isString(name) && isNumericArrayName(name) ? name : null;
}

function isNumericArrayName(name: string): name is keyof typeof NUMERIC_ARRAYS {
	return Object.prototype.hasOwnProperty.call(NUMERIC_ARRAYS, name);
}

function isNumericArray(value: RuntimeValue): value is NumericArray {
	return numericArrayName(value) !== null;
}

function description(
	kind: DatasetDescription["kind"],
	rowCount: number,
	columns: ColumnInfo[],
	schemaSource: DatasetDescription["schemaSource"],
	sampledRows: number,
): DatasetDescription {
	if (!Number.isSafeInteger(rowCount) || rowCount < 0)
		throw new TypeError("Dataset row count must be a nonnegative safe integer");
	return Object.freeze({
		kind,
		rowCount,
		columns: Object.freeze(columns.map((column) => Object.freeze(column))),
		schemaSource,
		sampledRows,
	});
}

function isArqueroDataset(value: RuntimeValue): value is RuntimeValue & ArqueroDataset {
	return (
		isObjectValue(value) &&
		["numRows", "columnNames", "objects", "select", "ungroup", "slice"].every((name) =>
			isCallable(dataProperty(value, name)),
		)
	);
}

function nativeColumns(fields: readonly NativeField[]): ColumnInfo[] {
	return fields.map((field) => {
		const name = dataProperty(field, "name");
		if (!isString(name)) throw new TypeError("Dataset column name must be a string");
		const nullable = dataProperty(field, "nullable");
		return { name, type: nativeTypeName(dataProperty(field, "type")), nullable: isBoolean(nullable) ? nullable : null };
	});
}

function nativeTypeName(type: RuntimeValue): string {
	if (isString(type)) return type;
	if (!hasDataProperties(type)) return "unknown";
	const format = dataProperty(type, "toString");
	if (isCallable(format) && format !== Object.prototype.toString) {
		// SAFETY: The data-property formatter is callable, and its result is checked before publication.
		const text = (format as TypeFormatter).call(type);
		if (isString(text)) return text;
	}
	return JSON.stringify(type) ?? "unknown";
}

function arraySchema(value: RuntimeValue[]): ColumnInfo[] | null {
	const schema = Object.getOwnPropertyDescriptor(value, "schema")?.value;
	const fields = dataArray(schema) ?? dataArray(dataProperty(schema, "fields"));
	if (fields?.every(isNativeField)) return nativeColumns(fields);
	const names = dataArray(Object.getOwnPropertyDescriptor(value, "columns")?.value);
	if (names?.every(isString)) return names.map((name) => ({ name, type: "unknown", nullable: null }));
	return null;
}

function nativeArraySchema(value: RuntimeValue[]): Schema | null {
	const schema = Object.getOwnPropertyDescriptor(value, "schema")?.value;
	const fields = dataArray(dataProperty(schema, "fields"));
	if (
		isObjectValue(schema) &&
		fields?.every((field) => isNativeField(field) && isNumber(dataProperty(dataProperty(field, "type"), "typeId"))) &&
		hasDataProperties(schema)
	) {
		// SAFETY: Native Arrow field metadata is normalized by the SDK bridge before use.
		return schema as Schema;
	}
	return null;
}

function isRow(value: RuntimeValue): value is Row {
	return isObjectValue(value) && (dataTag(value) === "[object Object]" || isArrowRow(value));
}

function isArrowRow(value: RuntimeValue): value is Row {
	return isObjectValue(value) && dataTag(value) === "[object Row]";
}

function dataTag(value: RuntimeValue): string | null {
	const tag = propertyDescriptor(value, Symbol.toStringTag);
	return tag && !("value" in tag) ? null : Object.prototype.toString.call(value);
}

function hasDataProperties(value: RuntimeValue, seen = new WeakSet<object>(), depth = 0): boolean {
	if (isCallable(value)) return false;
	if (!isObjectValue(value)) return true;
	const formatter = propertyDescriptor(value, "toString");
	if (formatter && !("value" in formatter)) return false;
	if (depth > 30 || propertyDescriptor(value, "toJSON")) return false;
	if (seen.has(value)) return true;
	seen.add(value);
	return Reflect.ownKeys(value).every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			!!descriptor &&
			"value" in descriptor &&
			(!descriptor.enumerable || hasDataProperties(descriptor.value, seen, depth + 1))
		);
	});
}

function isScalar(value: RuntimeValue): boolean {
	return value === null || value === undefined || !isObjectValue(value) || value instanceof Date;
}

function inferColumns(rows: readonly RuntimeValue[], names?: readonly string[]): ColumnInfo[] {
	const columns = names ?? rowNames(rows);
	return columns.map((name) =>
		inferColumn(
			name,
			rows.map((row) => ownValue(row, name)),
		),
	);
}

function rowNames(rows: readonly RuntimeValue[]): string[] {
	return [
		...new Set(
			rows.flatMap((row) =>
				isRow(row)
					? Object.keys(row).filter((name) => {
							const descriptor = Object.getOwnPropertyDescriptor(row, name);
							return isArrowRow(row) || (descriptor && "value" in descriptor);
						})
					: [],
			),
		),
	];
}

function inferColumn(name: string, values: readonly RuntimeValue[]): ColumnInfo {
	const types = new Set(
		values
			.filter((value) => value !== null && value !== undefined)
			.map((value) => (value instanceof Date ? "date" : javaScriptKind(value))),
	);
	return {
		name,
		type: types.size > 1 ? "mixed" : (types.values().next().value ?? "unknown"),
		nullable: values.length ? values.some((value) => value === null || value === undefined) : null,
	};
}

function ownValue(value: RuntimeValue, name: string): RuntimeValue {
	if (!isObjectValue(value)) return undefined;
	// Arrow rows expose their schema fields through a native Proxy.
	if (isArrowRow(value) && Object.prototype.hasOwnProperty.call(value, name)) return value[name];
	return Object.getOwnPropertyDescriptor(value, name)?.value;
}

function selectRow(row: RuntimeValue, columns: readonly string[]): Row {
	return Object.fromEntries(columns.map((name) => [name, ownValue(row, name)]));
}

function validateRowProperties(rows: readonly RuntimeValue[], columns?: readonly string[]): void {
	for (const row of rows) {
		if (!isObjectValue(row)) continue;
		for (const key of columns ?? Reflect.ownKeys(row)) {
			const descriptor = Object.getOwnPropertyDescriptor(row, key);
			if (!descriptor || (!descriptor.enumerable && !columns)) continue;
			if (!isString(key)) throw new TypeError("Dataset rows cannot export enumerable symbol properties");
			if ("get" in descriptor || "set" in descriptor) throw new TypeError(`Dataset row property ${key} is an accessor`);
		}
	}
}

function integerType(values: readonly RuntimeValue[], arrow: typeof import("apache-arrow")) {
	if (!values.every((value) => value === null || isBigInt(value))) return undefined;
	const integers = values.filter(isBigInt);
	const signed = integers.every((value) => value >= -(1n << 63n) && value < 1n << 63n);
	if (signed) return new arrow.Int64();
	if (integers.every((value) => value >= 0n && value < 1n << 64n)) return new arrow.Uint64();
	throw new RangeError("BigInt values exceed the range of an Arrow 64-bit integer column");
}

function nonnegativeIndex(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
	return value;
}

function emptyColumnType(type: string, arrow: typeof import("apache-arrow")) {
	switch (type.toLowerCase()) {
		case "string":
			return new arrow.Utf8();
		case "number":
		case "integer":
			return new arrow.Float64();
		case "boolean":
			return new arrow.Bool();
		case "bigint":
			return new arrow.Int64();
		case "date":
		case "datetime":
			return new arrow.TimestampMillisecond();
		default:
			return new arrow.Null();
	}
}
