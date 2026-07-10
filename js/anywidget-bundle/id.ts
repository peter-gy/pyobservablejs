let fallbackSequence = 0;

export function createBundleId(): string {
	const randomUUID = globalThis.crypto?.randomUUID;
	if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
	fallbackSequence += 1;
	return `bundle-${fallbackSequence.toString(36)}-${randomPart()}`;
}

function randomPart(): string {
	const getRandomValues = globalThis.crypto?.getRandomValues;
	if (typeof getRandomValues === "function") {
		const values = new Uint32Array(2);
		getRandomValues.call(globalThis.crypto, values);
		return [...values].map((value) => value.toString(36)).join("-");
	}
	return Math.random().toString(36).slice(2);
}
