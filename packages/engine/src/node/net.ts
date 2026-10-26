export function isIP(host: string): 0 | 4 | 6 {
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return 4;
	return host.includes(":") ? 6 : 0;
}
