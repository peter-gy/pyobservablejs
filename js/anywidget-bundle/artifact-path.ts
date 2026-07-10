const JAVASCRIPT_EXTENSIONS = [".js", ".mjs"] as const;
const INVALID_FILENAME_CHARACTERS = '<>:"|?*[]';
const RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
// Keep recent case pairs explicit so JavaScript and Python produce the same
// collision key when their bundled Unicode databases have different versions.
const RECENT_CASE_PAIRS = new Map([
	[0x1c89, 0x1c8a],
	[0xa7cb, 0x0264],
	[0xa7cc, 0xa7cd],
	[0xa7ce, 0xa7cf],
	[0xa7d2, 0xa7d3],
	[0xa7d4, 0xa7d5],
	[0xa7da, 0xa7db],
	[0xa7dc, 0x019b],
]);
// These marks have different combining classes across supported runtime
// Unicode versions, which would make NFC collision checks disagree.
const VERSION_SENSITIVE_COMBINING_MARK_RANGES: readonly (readonly [number, number])[] = [
	[0x0897, 0x0897],
	[0x1acf, 0x1add],
	[0x1ae0, 0x1aeb],
	[0x10d69, 0x10d6d],
	[0x10efa, 0x10efb],
	[0x10efd, 0x10eff],
	[0x113ce, 0x113d0],
	[0x11f41, 0x11f42],
	[0x1612f, 0x1612f],
	[0x1e08f, 0x1e08f],
	[0x1e4ec, 0x1e4ef],
	[0x1e5ee, 0x1e5ef],
	[0x1e6e3, 0x1e6e3],
	[0x1e6e6, 0x1e6e6],
	[0x1e6ee, 0x1e6ef],
	[0x1e6f5, 0x1e6f5],
];

// Manifest paths cross JavaScript, Python, URLs, and package filesystems. Keep
// validation on the portable subset shared by every boundary.
export function isSafeArtifactPath(value: string): boolean {
	const parts = value.split("/");
	return (
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("#") &&
		parts.every(
			(part) =>
				part !== "" &&
				part !== "." &&
				part !== ".." &&
				!part.endsWith(".") &&
				!part.endsWith(" ") &&
				![...part].some(isInvalidFilenameCharacter) &&
				!RESERVED_FILENAME.test(part),
		)
	);
}

function isInvalidFilenameCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0);
	return (
		codePoint === undefined ||
		INVALID_FILENAME_CHARACTERS.includes(character) ||
		codePoint < 32 ||
		codePoint === 127 ||
		(codePoint >= 0xd800 && codePoint <= 0xdfff) ||
		VERSION_SENSITIVE_COMBINING_MARK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)
	);
}

export function isJavaScriptArtifactPath(value: string): boolean {
	return isSafeArtifactPath(value) && JAVASCRIPT_EXTENSIONS.some((extension) => value.endsWith(extension));
}

export function javascriptExtension(value: string): ".js" | ".mjs" {
	if (value.endsWith(".mjs")) return ".mjs";
	if (value.endsWith(".js")) return ".js";
	throw new Error(`Expected a JavaScript bundle path, received ${value}.`);
}

export function artifactPathsConflict(paths: readonly string[]): boolean {
	// Catch case and normalization aliases plus file-directory overlaps before a
	// filesystem can merge distinct manifest entries.
	const normalized = paths.map(portableCaseFold);
	return normalized.some((path, index) =>
		normalized.some((other, otherIndex) =>
			index === otherIndex ? false : path === other || path.startsWith(`${other}/`),
		),
	);
}

function portableCaseFold(value: string): string {
	// Use per-code-point upper-then-lower casing because Python mirrors this exact
	// transform. Its full casefold operation expands some characters differently.
	return [...value.normalize("NFC")]
		.map((character) =>
			String.fromCodePoint(compatibleCaseCodePoint(character.codePointAt(0)!))
				.toUpperCase()
				.toLowerCase(),
		)
		.join("");
}

function compatibleCaseCodePoint(codePoint: number): number {
	const paired = RECENT_CASE_PAIRS.get(codePoint);
	if (paired !== undefined) return paired;
	if (codePoint >= 0x10d50 && codePoint <= 0x10d65) return codePoint + 0x20;
	if (codePoint >= 0x16ea0 && codePoint <= 0x16eb8) return codePoint + 0x1b;
	return codePoint;
}
