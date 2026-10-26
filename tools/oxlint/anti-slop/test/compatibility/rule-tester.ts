import type { Rule } from "vite-plus/lint/plugins";

import { describe, it } from "node:test";
import { RuleTester } from "vite-plus/lint/plugins-dev";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { lang: "ts" },
    sourceType: "module",
  },
});

/** Register focused TypeScript accept and reject cases for an anti-slop rule. */
export function testRule(name: string, rule: Rule, cases: RuleTester.TestCases): void {
  ruleTester.run(name, rule, cases);
}
