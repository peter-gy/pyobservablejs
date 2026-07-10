export async function waitFor<T>(read: () => T | undefined, timeoutMs = 1000): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	return new Promise<T>((resolve, reject) => {
		const check = () => {
			let value: T | undefined;
			try {
				value = read();
			} catch (error) {
				reject(error);
				return;
			}
			if (value !== undefined) {
				resolve(value);
			} else if (performance.now() >= deadline) {
				reject(new Error("Timed out waiting for value"));
			} else {
				window.setTimeout(check, 10);
			}
		};
		check();
	});
}
