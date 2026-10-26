/** Build a stand-in for Node I/O that Happy DOM reaches only through its own networking. */
export function unavailable(name: string) {
	return (): never => {
		throw new Error(`${name} is unavailable in the embedded notebook engine`);
	};
}
