export type JavaScriptKind =
	| "bigint"
	| "boolean"
	| "function"
	| "null"
	| "number"
	| "object"
	| "string"
	| "symbol"
	| "undefined";

const objectToString = Object.prototype.toString;
const functionToString = Function.prototype.toString;

function hasPrimitiveTag<Value>(value: Value, tag: string): boolean {
	return value !== null && value !== undefined && Object(value) !== value && objectToString.call(value) === tag;
}

export function isBigInt<Value>(value: Value): value is Value & bigint {
	return hasPrimitiveTag(value, "[object BigInt]");
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
	return hasPrimitiveTag(value, "[object Boolean]");
}

export function isNumber<Value>(value: Value): value is Value & number {
	return hasPrimitiveTag(value, "[object Number]");
}

export function isString<Value>(value: Value): value is Value & string {
	return hasPrimitiveTag(value, "[object String]");
}

export function isSymbol<Value>(value: Value): value is Value & symbol {
	return hasPrimitiveTag(value, "[object Symbol]");
}

export function isCallable<Value>(value: Value): value is Value & CallableFunction {
	try {
		// Function.prototype.toString recognizes callable proxies and functions from other realms.
		functionToString.call(value);
		return true;
	} catch {
		return false;
	}
}

export function isObjectValue<Value>(value: Value): value is Value & object {
	return value !== null && value !== undefined && Object(value) === value;
}

export function javaScriptKind<Value>(value: Value): JavaScriptKind {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (isBoolean(value)) return "boolean";
	if (isNumber(value)) return "number";
	if (isString(value)) return "string";
	if (isBigInt(value)) return "bigint";
	if (isSymbol(value)) return "symbol";
	if (isCallable(value)) return "function";
	return "object";
}
