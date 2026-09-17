import type { RuntimeCellDefinition } from "./definition";

export function hostOwnedNames(
	definition: RuntimeCellDefinition,
	exposed: string[],
	variableNames: Set<string>,
): string[] {
	if (definition.autoview || definition.automutable) return [];
	return exposed.filter((name) => variableNames.has(name));
}

export function sourceRuntimeDefinition(
	definition: RuntimeCellDefinition,
	ownedNames: readonly string[],
): RuntimeCellDefinition {
	if (!definition.outputs || ownedNames.length === 0) return definition;
	const ownedNameSet = new Set(ownedNames);
	return {
		...definition,
		outputs: definition.outputs.filter((name) => !ownedNameSet.has(name)),
	};
}
