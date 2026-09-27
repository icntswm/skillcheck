import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError, parseSuite } from "./cases.js";

export interface ImportedSuite {
  text: string;
  positive: number;
  negative: number;
}

const PLAIN_NAME = /^[A-Za-z0-9._:/-]+$/;

/**
 * A skill-creator trigger eval set ([{query, should_trigger}], one skill) as a
 * cases file: should_trigger true becomes expect, false becomes forbid.
 */
export function evalSetToSuite(data: unknown, skill: string, source: string): ImportedSuite {
  const errors: string[] = [];
  if (!Array.isArray(data) || data.length === 0) {
    throw new ConfigError(["expected a JSON array of {query, should_trigger}"]);
  }
  const items: { query: string; trigger: boolean }[] = [];
  data.forEach((item: unknown, i) => {
    const n = i + 1;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`item ${n}: expected an object with query and should_trigger`);
      return;
    }
    const { query, should_trigger: trigger } = item as Record<string, unknown>;
    if (typeof query !== "string" || query.trim() === "") errors.push(`item ${n}: query must be a non-empty string`);
    if (typeof trigger !== "boolean") errors.push(`item ${n}: should_trigger must be true or false`);
    if (typeof query === "string" && typeof trigger === "boolean") items.push({ query, trigger });
  });
  if (errors.length > 0) throw new ConfigError(errors);

  // plain only when YAML reads it back as the same string: not true, null, 123
  const name = PLAIN_NAME.test(skill) && parseYaml(skill) === skill ? skill : JSON.stringify(skill);
  const lines = [
    `# skillcheck cases imported from ${path.basename(source)} (skill-creator trigger eval set).`,
    "# should_trigger: true became expect, false became forbid: another skill may",
    `# still load there, only ${skill} must not.`,
    "agent: claude",
    "repeat: 1",
    "threshold: 1.0",
    "cases:",
  ];
  for (const { query, trigger } of items) {
    // a JSON string is a valid YAML double-quoted scalar, newlines and quotes included
    lines.push(`  - query: ${JSON.stringify(query)}`, `    ${trigger ? "expect" : "forbid"}: [${name}]`);
  }
  const text = lines.join("\n") + "\n";
  parseSuite(parseYaml(text));
  const positive = items.filter((i) => i.trigger).length;
  return { text, positive, negative: items.length - positive };
}
