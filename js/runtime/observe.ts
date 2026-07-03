export function observe<T>(
	initialize: (notify: (value: T) => T) => (() => void) | undefined,
): AsyncGenerator<T, void, unknown> {
	let resolve: ((value: T) => void) | undefined;
	let reject: ((error: unknown) => void) | undefined;
	let value: T;
	let stale = false;
	const dispose = initialize((next) => {
		value = next;
		if (resolve) {
			resolve(next);
			resolve = undefined;
			reject = undefined;
		} else {
			stale = true;
		}
		return next;
	});
	return {
		async next() {
			return {
				done: false,
				value: await (stale
					? ((stale = false), value)
					: new Promise<T>((res, rej) => {
							resolve = res;
							reject = rej;
						})),
			};
		},
		async return() {
			reject?.(new Error("Generator returned"));
			resolve = undefined;
			reject = undefined;
			dispose?.();
			return { done: true, value: undefined };
		},
		async throw(error) {
			reject?.(error);
			resolve = undefined;
			reject = undefined;
			dispose?.();
			return { done: true, value: undefined };
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}
