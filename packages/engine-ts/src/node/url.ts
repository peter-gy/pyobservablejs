export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

/** Convert a domain to its ASCII form, or return "" for an invalid domain. */
export function domainToASCII(domain: string): string {
	try {
		return new URL(`http://${domain}`).hostname;
	} catch {
		return "";
	}
}

export default { URL, URLSearchParams, domainToASCII };
