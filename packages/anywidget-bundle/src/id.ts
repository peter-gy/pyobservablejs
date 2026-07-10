let fallbackSequence = 0;

export function createBundleId(): string {
	const crypto = globalThis.crypto;
	if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
	fallbackSequence += 1;
	return `bundle-${fallbackSequence.toString(36)}-${randomPart()}`;
}

function randomPart(): string {
	const crypto = globalThis.crypto;
	if (typeof crypto?.getRandomValues === "function") {
		const values = new Uint32Array(2);
		crypto.getRandomValues(values);
		return [...values].map((value) => value.toString(36)).join("-");
	}
	return Math.random().toString(36).slice(2);
}
