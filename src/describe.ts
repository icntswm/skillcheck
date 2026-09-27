import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface SkillDoc {
  name: string;
  kind: "skill" | "command";
  file: string;
  description: string;
  /** plugin name for plugin docs, null for user and project docs */
  plugin: string | null;
}

/** Config roots to scan, earlier first: user config, then project (project overrides).
 * An explicit configDir beats CLAUDE_CONFIG_DIR. */
export function skillRoots(opts?: { home?: string; cwd?: string; configDir?: string }): string[] {
  const home = opts?.home ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const configRoot = opts?.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return [configRoot, path.join(cwd, ".claude")];
}

/** Skill dir names under dir: subdirs with a SKILL.md, symlinks followed. */
export function skillDirNames(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    // statSync follows symlinks, so linked skill dirs count too
    try {
      if (fs.statSync(path.join(dir, entry)).isDirectory()
        && fs.statSync(path.join(dir, entry, "SKILL.md")).isFile()) {
        out.push(entry);
      }
    } catch {
      // not a skill dir
    }
  }
  return out;
}

/** Command names under dir: top-level .md files. */
export function commandNames(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      if (fs.statSync(path.join(dir, entry)).isFile()) out.push(entry.slice(0, -3));
    } catch {
      // not a regular file
    }
  }
  return out;
}

export function loadSkillDocs(opts?: { home?: string; cwd?: string; configDir?: string }): SkillDoc[] {
  const cwd = opts?.cwd ?? process.cwd();
  const byName = new Map<string, SkillDoc>();
  const roots = skillRoots(opts);
  for (const root of roots) {
    const inRoot = new Map<string, SkillDoc>();
    for (const name of commandNames(path.join(root, "commands"))) {
      const file = path.join(root, "commands", `${name}.md`);
      inRoot.set(name, { name, kind: "command", file, description: readDescription(file), plugin: null });
    }
    // within one root a skill beats a command with the same name
    for (const name of skillDirNames(path.join(root, "skills"))) {
      const file = path.join(root, "skills", name, "SKILL.md");
      inRoot.set(name, { name, kind: "skill", file, description: readDescription(file), plugin: null });
    }
    // a later root overrides an earlier one
    for (const [name, doc] of inRoot) byName.set(name, doc);
  }
  // plugin docs carry a `plugin:` prefix, so they never collide with the above
  for (const doc of pluginDocs(roots[0] as string, cwd)) {
    if (!byName.has(doc.name)) byName.set(doc.name, doc);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Description from frontmatter plus when_to_use; never throws, "" when absent. */
function readDescription(file: string): string {
  return describeFrom(readFrontmatter(file));
}

function describeFrom(fm: FrontFields): string {
  const description = fm.description;
  if (description === undefined) return "";
  const when = fm.whenToUse;
  const joined = when !== undefined && when.length > 0 ? `${description} ${when}` : description;
  return joined.replace(/\s+/g, " ").trim();
}

function readFrontmatter(file: string): FrontFields {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return {};
  return frontmatter(lines.slice(1, end));
}

interface FrontFields {
  name?: string;
  description?: string;
  whenToUse?: string;
}

function frontmatter(body: string[]): FrontFields {
  try {
    // descriptions are often multi-line `>-` scalars, so this needs a real yaml parser
    const parsed: unknown = parseYaml(body.join("\n"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const out: FrontFields = {};
      if (typeof obj.name === "string") out.name = obj.name;
      if (typeof obj.description === "string") out.description = obj.description;
      if (typeof obj.when_to_use === "string") out.whenToUse = obj.when_to_use;
      return out;
    }
  } catch {
    // fall through: Claude Code accepts files yaml does not
  }
  // real command files carry non-YAML lines like `argument-hint: [PROJ-1234] [repo]`
  // that break the whole document; read the fields we need line by line instead
  return {
    name: readField(body, "name"),
    description: readField(body, "description"),
    whenToUse: readField(body, "when_to_use"),
  };
}

const BLOCK_MARKERS = new Set(["", ">", ">-", "|", "|-"]);

/** Line-based value of a top-level frontmatter key; folded scalars continue below. */
function readField(lines: string[], key: string): string | undefined {
  const prefix = `${key}:`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length).trim();
    if (!BLOCK_MARKERS.has(rest)) return unquote(rest);
    const parts: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j] as string;
      if (cont.trim() === "") continue;
      if (cont !== cont.trimStart()) parts.push(cont.trim()); // indented deeper than the key
      else break;
    }
    return parts.length > 0 ? unquote(parts.join(" ")) : undefined;
  }
  return undefined;
}

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value[value.length - 1] === first) {
    return value.slice(1, -1);
  }
  return value;
}

/** Plugin skills and commands registered under the user config root. */
function pluginDocs(configRoot: string, cwd: string): SkillDoc[] {
  const registry = readJson(path.join(configRoot, "plugins", "installed_plugins.json"));
  const plugins = registry?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const disabled = disabledPlugins(configRoot);
  const out: SkillDoc[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (disabled.has(key)) continue;
    if (!Array.isArray(entries)) continue;
    const plugin = key.split("@")[0] as string; // name is the part before the marketplace
    for (const raw of entries) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const scoped = entry.scope === "project" || entry.scope === "local";
      if (entry.scope !== "user" && !(scoped && entry.projectPath === cwd)) continue;
      const installPath = entry.installPath;
      if (typeof installPath !== "string" || installPath === "") continue;
      out.push(...pluginSkillDocs(plugin, installPath), ...pluginCommandDocs(plugin, installPath));
    }
  }
  return out;
}

function disabledPlugins(configRoot: string): Set<string> {
  const enabled = readJson(path.join(configRoot, "settings.json"))?.enabledPlugins;
  const out = new Set<string>();
  if (typeof enabled !== "object" || enabled === null) return out;
  for (const [key, value] of Object.entries(enabled)) {
    if (value === false) out.add(key);
  }
  return out;
}

function pluginSkillDocs(plugin: string, installPath: string): SkillDoc[] {
  const declared = pluginManifest(installPath)?.skills;
  const dirs = Array.isArray(declared)
    ? declared.filter((s): s is string => typeof s === "string").map((rel) => path.resolve(installPath, rel))
    : skillDirNames(path.join(installPath, "skills")).map((name) => path.join(installPath, "skills", name));
  const out: SkillDoc[] = [];
  for (const dir of dirs) {
    const file = path.join(dir, "SKILL.md");
    if (!isFile(file)) continue;
    const fm = readFrontmatter(file);
    const name = fm.name !== undefined && fm.name.trim() !== "" ? fm.name.trim() : path.basename(dir);
    out.push({ name: `${plugin}:${name}`, kind: "skill", file, description: describeFrom(fm), plugin });
  }
  return out;
}

function pluginCommandDocs(plugin: string, installPath: string): SkillDoc[] {
  const declared = pluginManifest(installPath)?.commands;
  let files: string[];
  if (Array.isArray(declared)) {
    files = [];
    for (const entry of declared) {
      if (typeof entry !== "string") continue;
      const p = path.resolve(installPath, entry);
      if (isFile(p)) {
        if (p.endsWith(".md")) files.push(p);
      } else {
        files.push(...commandFiles(p));
      }
    }
  } else {
    files = commandFiles(path.join(installPath, "commands"));
  }
  return files.map((file) => ({
    name: `${plugin}:${path.basename(file).replace(/\.md$/, "")}`,
    kind: "command" as const,
    file,
    description: readDescription(file),
    plugin,
  }));
}

function commandFiles(dir: string): string[] {
  return commandNames(dir).map((name) => path.join(dir, `${name}.md`));
}

function pluginManifest(installPath: string): Record<string, unknown> | null {
  return readJson(path.join(installPath, ".claude-plugin", "plugin.json"));
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null; // missing or broken registry just means no plugins
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
