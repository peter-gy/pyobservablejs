import type { Data, DataType, Field, Schema, Table } from "apache-arrow";
import type { Table as FlechetteTable, Field as FlechetteField, DataType as FlechetteType } from "@uwdata/flechette";
import { isCallable, isNumber, isObjectValue, isString } from "./value-kind";
import type { RuntimeValue } from "./values";

export type NativeField = { name: string; type: RuntimeValue; nullable?: boolean };
export interface ArrowDataset {
	schema: { fields: NativeField[] };
	numRows: number;
	getChild(name: string): { get(index: number): RuntimeValue } | null | undefined;
	get(index: number): RuntimeValue;
	toArray(): RuntimeValue[];
	select(columns: string[]): ArrowDataset;
}
type ForeignData<T extends DataType = DataType> = Pick<
	Data<T>,
	"type" | "offset" | "length" | "nullCount" | "buffers"
> & {
	children: readonly ForeignData[];
	dictionary?: { data: readonly ForeignData[] };
	variadicBuffers?: readonly Uint8Array[];
};
export function isArrowDataset(value: RuntimeValue): value is RuntimeValue & ArrowDataset {
	if (!isObjectValue(value)) return false;
	const fields = dataArray(dataProperty(dataProperty(value, "schema"), "fields"));
	if (
		!fields?.every(isNativeField) ||
		!["getChild", "get", "select", "toArray"].every((name) => isCallable(dataProperty(value, name)))
	)
		return false;
	// Native tables compute their row count with a getter after the schema and methods establish the protocol.
	return "numRows" in value && isNumber(value.numRows);
}

export function isNativeField(value: RuntimeValue): value is NativeField {
	const type = propertyDescriptor(value, "type");
	return isString(dataProperty(value, "name")) && !!type && "value" in type;
}

export function propertyDescriptor(value: RuntimeValue, key: PropertyKey): PropertyDescriptor | undefined {
	const seen = new WeakSet<object>();
	while (isObjectValue(value) && !seen.has(value)) {
		seen.add(value);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor) return descriptor;
		value = Object.getPrototypeOf(value);
	}
	return undefined;
}

export function dataProperty(value: RuntimeValue, key: PropertyKey): RuntimeValue {
	const descriptor = propertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function dataArray(value: RuntimeValue, limit = Infinity): RuntimeValue[] | null {
	if (!Array.isArray(value)) return null;
	const items: RuntimeValue[] = [];
	const length = dataProperty(value, "length");
	if (!isNumber(length)) return null;
	for (let index = 0; index < Math.min(length, limit); index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor && !("value" in descriptor)) return null;
		items.push(descriptor?.value);
	}
	return items;
}

export async function arrowBytes(table: ArrowDataset): Promise<Uint8Array> {
	if ("children" in table && !("batches" in table)) {
		const flechette = await import("@uwdata/flechette");
		// SAFETY: Flechette tables expose native schema and child batches through this protocol.
		const bytes = flechette.tableToIPC(table as FlechetteTable, { format: "stream" });
		if (!bytes) throw new Error("Arrow IPC export did not return bytes");
		return bytes;
	}
	const arrow = await import("apache-arrow");
	const native = await apacheTable(table);
	// Arrow JS infers nameless list elements and omits those names in IPC.
	// Give internal child fields a name before encoding for strict Arrow readers.
	const schema = await arrowSchema(native.schema, true);
	const bytes = arrow.tableToIPC(
		new arrow.Table(
			schema,
			native.batches.map((batch) => new arrow.RecordBatch(schema, batch.data)),
		),
	);
	if (!hasEmptyFieldName(schema.fields)) return bytes;
	// Arrow JS omits empty logical names; Flechette writes the explicit empty
	// strings required by strict readers. Buffers remain columnar throughout.
	const flechette = await import("@uwdata/flechette");
	const decoded = flechette.tableFromIPC(bytes);
	const restore = (fields: FlechetteField[]) => {
		for (const field of fields) {
			field.name ??= "";
			visit(field.type);
		}
	};
	const visit = (type: FlechetteType) => {
		if ("children" in type) restore(type.children);
		if (type.typeId === flechette.Type.Dictionary) visit(type.dictionary);
	};
	restore(decoded.schema.fields);
	const encoded = flechette.tableToIPC(decoded, { format: "stream" });
	if (!encoded) throw new Error("Arrow IPC export did not return bytes");
	return encoded;
}

function hasEmptyFieldName(fields: readonly Field[]): boolean {
	return fields.some((field) => field.name === "" || hasEmptyFieldName(field.type.children ?? []));
}

export async function apacheTable(table: ArrowDataset): Promise<Table> {
	const arrow = await import("apache-arrow");
	if (table instanceof arrow.Table && table.constructor === arrow.Table) return table;
	if ("children" in table && !("batches" in table)) return arrow.tableFromIPC(await arrowBytes(table));
	// SAFETY: The Arrow table protocol supplies schema, batches, and native Data buffers across SDK versions.
	const source = table as Table;
	const { wrapField, wrapType } = typeConverters(arrow);
	const schema = new arrow.Schema(
		source.schema.fields.map((field) => wrapField(field)),
		new Map(source.schema.metadata),
	);
	const wrapData = <T extends DataType>(data: ForeignData<T>): Data<T> =>
		data instanceof arrow.Data && data.constructor === arrow.Data
			? data
			: new arrow.Data(
					wrapType(data.type),
					data.offset,
					data.length,
					data.nullCount,
					data.buffers,
					data.children.map(wrapData),
					data.dictionary ? new arrow.Vector(data.dictionary.data.map(wrapData)) : undefined,
					data.variadicBuffers,
				);
	const batches = source.batches.map((batch) => new arrow.RecordBatch(schema, wrapData(batch.data)));
	return batches.length ? new arrow.Table(batches) : new arrow.Table(schema);
}

export async function arrowSchema(schema: Schema, nameListChildren = false): Promise<Schema> {
	const arrow = await import("apache-arrow");
	const { wrapField } = typeConverters(arrow, nameListChildren);
	return new arrow.Schema(
		schema.fields.map((field) => wrapField(field)),
		new Map(schema.metadata),
	);
}

function typeConverters(arrow: typeof import("apache-arrow"), nameListChildren = false) {
	const types = new WeakMap<DataType, DataType>();
	function wrapField<T extends DataType>(field: Field<T>, name = field.name): Field<T> {
		return new arrow.Field(name, wrapType(field.type), field.nullable, new Map(field.metadata));
	}
	function wrapType<T extends DataType>(type: T): T {
		if (
			type instanceof arrow.DataType &&
			(!nameListChildren || (!type.children?.length && !arrow.DataType.isDictionary(type)))
		)
			return type;
		let native = types.get(type);
		if (!native) {
			native = nativeType(type);
			types.set(type, native);
		}
		// SAFETY: Native constructors preserve the source type's logical parameters and children.
		return native as T;
	}
	function nativeType(type: DataType): DataType {
		const id = type.typeId;
		if (arrow.DataType.isInt(type)) return new arrow.Int(type.isSigned, type.bitWidth);
		if (arrow.DataType.isFloat(type)) return new arrow.Float(type.precision);
		if (arrow.DataType.isDictionary(type))
			return new arrow.Dictionary(wrapType(type.dictionary), wrapType(type.indices), type.id, type.isOrdered);
		if (arrow.DataType.isTimestamp(type)) return new arrow.Timestamp(type.unit, type.timezone);
		if (arrow.DataType.isDate(type)) return new arrow.Date_(type.unit);
		if (arrow.DataType.isTime(type)) return new arrow.Time(type.unit, type.bitWidth);
		if (arrow.DataType.isDecimal(type)) return new arrow.Decimal(type.scale, type.precision, type.bitWidth);
		if (arrow.DataType.isInterval(type)) return new arrow.Interval(type.unit);
		if (arrow.DataType.isDuration(type)) return new arrow.Duration(type.unit);
		if (arrow.DataType.isList(type))
			return new arrow.List(
				wrapField(type.children[0], nameListChildren ? type.children[0].name || "item" : type.children[0].name),
			);
		if (arrow.DataType.isLargeList(type))
			return new arrow.LargeList(
				wrapField(type.children[0], nameListChildren ? type.children[0].name || "item" : type.children[0].name),
			);
		if (arrow.DataType.isFixedSizeList(type))
			return new arrow.FixedSizeList(
				type.listSize,
				wrapField(type.children[0], nameListChildren ? type.children[0].name || "item" : type.children[0].name),
			);
		if (arrow.DataType.isStruct(type)) return new arrow.Struct(type.children.map((field) => wrapField(field)));
		if (arrow.DataType.isMap(type))
			return new arrow.Map_(
				wrapField(type.children[0], nameListChildren ? type.children[0].name || "item" : type.children[0].name),
				type.keysSorted,
			);
		if (arrow.DataType.isUnion(type))
			return new arrow.Union(
				type.mode,
				Array.from(type.typeIds),
				type.children.map((field) => wrapField(field)),
			);
		if (arrow.DataType.isFixedSizeBinary(type)) return new arrow.FixedSizeBinary(type.byteWidth);
		if (arrow.DataType.isUtf8(type)) return new arrow.Utf8();
		if (arrow.DataType.isLargeUtf8(type)) return new arrow.LargeUtf8();
		if (arrow.DataType.isUtf8View(type)) return new arrow.Utf8View();
		if (arrow.DataType.isBinary(type)) return new arrow.Binary();
		if (arrow.DataType.isLargeBinary(type)) return new arrow.LargeBinary();
		if (arrow.DataType.isBinaryView(type)) return new arrow.BinaryView();
		if (arrow.DataType.isBool(type)) return new arrow.Bool();
		if (arrow.DataType.isNull(type)) return new arrow.Null();
		throw new TypeError(`Unsupported Arrow data type: ${id}`);
	}
	return { wrapField, wrapType };
}
