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

export function loadSkillDocs(opts?: { home?: string; cwd?: string; configDir?: string; pluginDirs?: string[] }): SkillDoc[] {
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
  const sources = sourcePlugins(opts?.pluginDirs ?? []);
  const sourceNames = new Set(sources.map((p) => p.plugin));
  for (const doc of pluginDocs(pluginInstallPaths(opts).filter((p) => !sourceNames.has(p.plugin)))) {
    if (!byName.has(doc.name)) byName.set(doc.name, doc);
  }
  for (const doc of pluginDocs(sources)) {
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
function pluginDocs(plugins: { plugin: string; installPath: string }[]): SkillDoc[] {
  return plugins.flatMap(({ plugin, installPath }) => {
    const manifest = pluginManifest(installPath);
    return [...pluginSkillDocs(plugin, installPath, manifest), ...pluginCommandDocs(plugin, installPath, manifest)];
  });
}

/** The plugins Claude Code loads for cwd, with their install dirs. */
export function pluginInstallPaths(opts?: { home?: string; cwd?: string; configDir?: string; pluginDirs?: string[] }): { plugin: string; installPath: string }[] {
  const installed = enabledPlugins(skillRoots(opts)[0] as string, opts?.cwd ?? process.cwd());
  const sources = sourcePlugins(opts?.pluginDirs ?? []);
  const sourceNames = new Set(sources.map((p) => p.plugin));
  return [...installed.filter((p) => !sourceNames.has(p.plugin)), ...sources];
}

export function sourcePlugins(dirs: string[]): { plugin: string; installPath: string }[] {
  const out: { plugin: string; installPath: string }[] = [];
  for (const dir of dirs) {
    if (isFile(path.join(dir, ".claude-plugin", "plugin.json"))) out.push(sourcePlugin(dir));
    else {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // statSync follows directory symlinks, so a linked child plugin counts too.
        const child = path.join(dir, entry.name);
        try {
          if (fs.statSync(child).isDirectory() && isFile(path.join(child, ".claude-plugin", "plugin.json"))) out.push(sourcePlugin(child));
        } catch { /* not a readable plugin directory */ }
      }
    }
  }
  return out;
}

function sourcePlugin(installPath: string): { plugin: string; installPath: string } {
  const name = pluginManifest(installPath)?.name;
  return { plugin: typeof name === "string" && name.trim() !== "" ? name.trim() : path.basename(installPath), installPath };
}

function enabledPlugins(configRoot: string, cwd: string): { plugin: string; installPath: string }[] {
  const registry = readJson(path.join(configRoot, "plugins", "installed_plugins.json"));
  const plugins = registry?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const disabled = disabledPlugins(configRoot);
  const out: { plugin: string; installPath: string }[] = [];
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
      out.push({ plugin, installPath });
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

type Manifest = Record<string, unknown> | null;

/** Manifest component paths: one string or an array of them, relative to the plugin root. */
function manifestPaths(installPath: string, declared: unknown): string[] {
  const list = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
  return list.filter((s): s is string => typeof s === "string").map((rel) => path.resolve(installPath, rel));
}

function pluginSkillDocs(plugin: string, installPath: string, manifest: Manifest): SkillDoc[] {
  // `skills` adds to the default skills/ scan; each entry holds <name>/SKILL.md dirs or SKILL.md itself
  const defaultDir = path.join(installPath, "skills");
  const declared = manifestPaths(installPath, manifest?.skills);
  const dirs: string[] = [];
  for (const root of [defaultDir, ...declared]) {
    if (isFile(path.join(root, "SKILL.md"))) dirs.push(root);
    else dirs.push(...skillDirNames(root).map((name) => path.join(root, name)));
  }
  // a bare SKILL.md at the root is a single-skill plugin
  if (dirs.length === 0 && declared.length === 0 && !isDir(defaultDir) && isFile(path.join(installPath, "SKILL.md"))) dirs.push(installPath);
  const out: SkillDoc[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const file = path.join(dir, "SKILL.md");
    if (!isFile(file) || seen.has(file)) continue;
    seen.add(file);
    const fm = readFrontmatter(file);
    const name = fm.name !== undefined && fm.name.trim() !== "" ? fm.name.trim() : path.basename(dir);
    out.push({ name: `${plugin}:${name}`, kind: "skill", file, description: describeFrom(fm), plugin });
  }
  return out;
}

function pluginCommandDocs(plugin: string, installPath: string, manifest: Manifest): SkillDoc[] {
  const declared = manifest?.commands;
  // an object map names each command: { name: { source | content, description? } }
  if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
    const manifestFile = path.join(installPath, ".claude-plugin", "plugin.json");
    const out: SkillDoc[] = [];
    for (const [name, raw] of Object.entries(declared)) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const source = typeof entry.source === "string" ? path.resolve(installPath, entry.source) : null;
      if (source === null && typeof entry.content !== "string") continue;
      const file = source !== null && isFile(source) ? source : manifestFile;
      const description = typeof entry.description === "string" ? entry.description : file === source ? readDescription(file) : "";
      out.push({ name: `${plugin}:${name}`, kind: "command", file, description, plugin });
    }
    return out;
  }
  // a path or an array replaces the default commands/ scan
  const files: string[] = [];
  const paths = declared === undefined ? [path.join(installPath, "commands")] : manifestPaths(installPath, declared);
  for (const p of paths) {
    if (isFile(p)) {
      if (p.endsWith(".md")) files.push(p);
    } else {
      files.push(...commandFiles(p));
    }
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

function pluginManifest(installPath: string): Manifest {
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

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
