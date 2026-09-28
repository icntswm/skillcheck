import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSkillDocs, pluginInstallPaths, sourcePlugins, type SkillDoc } from "../src/describe.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-describe-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function withConfig<T>(cfg: string, fn: () => T): T {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

function skill(root: string, name: string, frontmatter: string): void {
  writeFile(path.join(root, "skills", name, "SKILL.md"), `${frontmatter}body text\n`);
}

const byName = (docs: SkillDoc[], name: string): SkillDoc | undefined => docs.find((d) => d.name === name);

describe("loadSkillDocs", () => {
  it("parses a folded multi-line description and appends when_to_use", () => {
    const cfg = path.join(tmp, "folded-");
    skill(cfg, "folded", `---\nname: folded\ndescription: >-\n  Long description that spans\n  several lines\nwhen_to_use: When asked about folding\n---\n`);
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    const doc = byName(docs, "folded");
    expect(doc?.kind).toBe("skill");
    expect(doc?.description).toBe("Long description that spans several lines When asked about folding");
    expect(doc?.file).toBe(path.join(cfg, "skills", "folded", "SKILL.md"));
  });

  it("gives empty descriptions for missing frontmatter and missing fields, and recovers broken YAML", () => {
    const cfg = path.join(tmp, "broken-");
    skill(cfg, "no-fm", "# just a skill\n");
    skill(cfg, "bad-yaml", "---\ndescription: [unclosed\n---\n");
    skill(cfg, "no-field", "---\nname: x\n---\n");
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    expect(docs.map((d) => d.description)).toEqual(["[unclosed", "", ""]); // sorted by name
  });

  it("reads name, description and when_to_use line by line when YAML is invalid", () => {
    const cfg = path.join(tmp, "tolerant-");
    writeFile(path.join(cfg, "commands", "mr.md"), [
      "---",
      "description: Create and review MRs on the internal GitLab",
      "when_to_use: >",
      "  Any mention of merge requests",
      "  or CI pipelines",
      "argument-hint: [PROJ-1234] [репозиторий]",
      "---",
      "body",
    ].join("\n"));
    writeFile(path.join(cfg, "commands", "deploy.md"), [
      "---",
      "description:",
      "  'Quoted wrapped value'",
      "allowed-tools: [broken",
      "---",
      "body",
    ].join("\n"));
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    expect(byName(docs, "mr")?.description).toBe(
      "Create and review MRs on the internal GitLab Any mention of merge requests or CI pipelines",
    );
    expect(byName(docs, "deploy")?.description).toBe("Quoted wrapped value");
  });

  it("marks user and project docs with plugin null", () => {
    const cfg = path.join(tmp, "plugnull-");
    skill(cfg, "plain", "---\ndescription: A plain user skill with a long description\n---\n");
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    expect(byName(docs, "plain")?.plugin).toBeNull();
  });

  it("project root overrides the user root", () => {
    const cfg = path.join(tmp, "override-");
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    skill(cfg, "shared", "---\ndescription: user level description\n---\n");
    skill(path.join(cwd, ".claude"), "shared", "---\ndescription: project level description\n---\n");
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd }));
    expect(byName(docs, "shared")?.description).toBe("project level description");
  });

  it("a skill beats a command with the same name inside one root", () => {
    const cfg = path.join(tmp, "clash-");
    writeFile(path.join(cfg, "commands", "deploy.md"), "---\ndescription: command description\n---\n");
    skill(cfg, "deploy", "---\ndescription: skill description\n---\n");
    writeFile(path.join(cfg, "commands", "build.md"), "---\ndescription: build something from source files\n---\n");
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    expect(byName(docs, "deploy")).toMatchObject({ kind: "skill", description: "skill description" });
    expect(byName(docs, "build")).toMatchObject({ kind: "command" });
  });

  it("follows symlinked skill dirs", () => {
    const cfg = path.join(tmp, "symlink-");
    const real = fs.mkdtempSync(path.join(tmp, "real-"));
    writeFile(path.join(real, "linked", "SKILL.md"), "---\ndescription: reached through a symlink\n---\n");
    fs.mkdirSync(path.join(cfg, "skills"), { recursive: true });
    fs.symlinkSync(path.join(real, "linked"), path.join(cfg, "skills", "linked"), "dir");
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    expect(byName(docs, "linked")?.description).toBe("reached through a symlink");
  });

  it("returns one entry per name, sorted by name", () => {
    const cfg = path.join(tmp, "sorted-");
    skill(cfg, "zeta", "---\ndescription: zzz\n---\n");
    skill(cfg, "alpha", "---\ndescription: aaa\n---\n");
    writeFile(path.join(cfg, "commands", "mid.md"), "---\ndescription: mmm\n---\n");
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: tmp }));
    expect(docs.map((d) => d.name)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("loadSkillDocs plugins", () => {
  let base: string;

  function plugin(name: string, files: Record<string, string>): string {
    const root = path.join(base, "pl", name);
    writeFile(path.join(root, "README.md"), "not a skill\n");
    for (const [file, body] of Object.entries(files)) writeFile(path.join(root, file), body);
    return root;
  }

  // returns the config root; registry maps plugin name -> entries
  function registry(cfg: string, plugins: Record<string, unknown[]>, settings?: unknown): void {
    writeFile(path.join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
    if (settings !== undefined) writeFile(path.join(cfg, "settings.json"), JSON.stringify(settings));
  }

  const names = (docs: SkillDoc[]): string[] => docs.map((d) => d.name);

  function load(cfg: string, cwd: string): SkillDoc[] {
    return withConfig(cfg, () => loadSkillDocs({ cwd }));
  }

  it("reads skills and commands listed in the manifest", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-manifest-"));
    const cfg = path.join(base, "cfg");
    const demo = plugin("demo", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "demo", skills: ["./custom/greet", "./custom/renamed"], commands: ["./cmds", "./extra.md"] }),
      "custom/greet/SKILL.md": "---\ndescription: Greet the user politely in any language\n---\n",
      "custom/renamed/SKILL.md": "---\nname: hello\ndescription: Another greeting skill with a long text\n---\n",
      "cmds/talk.md": "---\ndescription: Talk about things all day long\n---\n",
      "extra.md": "---\ndescription: Extra command given as a file\n---\n",
    });
    registry(cfg, { "demo@mp": [{ scope: "user", installPath: demo }] });
    const docs = load(cfg, base);
    expect(names(docs)).toEqual(["demo:extra", "demo:greet", "demo:hello", "demo:talk"]);
    const greet = byName(docs, "demo:greet");
    expect(greet).toMatchObject({ kind: "skill", plugin: "demo" });
    expect(byName(docs, "demo:talk")?.kind).toBe("command");
    expect(byName(docs, "demo:hello")?.file).toBe(path.join(demo, "custom", "renamed", "SKILL.md"));
  });

  it("scans manifest skill roots next to skills/ and reads a command map", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-roots-"));
    const cfg = path.join(base, "cfg");
    const roots = plugin("roots", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "roots",
        skills: "./custom",
        commands: { about: { content: "About.", description: "Explain what this plugin does" }, run: { source: "./run.md" } },
      }),
      "skills/base/SKILL.md": "---\ndescription: Default folder skill still loads\n---\n",
      "custom/foo/SKILL.md": "---\ndescription: Skill found under a custom root\n---\n",
      "commands/ignored.md": "---\ndescription: Replaced by the manifest map\n---\n",
      "run.md": "---\ndescription: Run the thing from a source file\n---\n",
    });
    registry(cfg, { "roots@mp": [{ scope: "user", installPath: roots }] });
    const docs = load(cfg, base);
    expect(names(docs)).toEqual(["roots:about", "roots:base", "roots:foo", "roots:run"]);
    expect(byName(docs, "roots:about")?.description).toBe("Explain what this plugin does");
    expect(byName(docs, "roots:run")?.description).toBe("Run the thing from a source file");
  });

  it("loads a plugin with only a root SKILL.md as one skill", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-single-"));
    const cfg = path.join(base, "cfg");
    const single = plugin("single", { "SKILL.md": "---\nname: solo\ndescription: The only skill of this plugin\n---\n" });
    registry(cfg, { "single@mp": [{ scope: "user", installPath: single }] });
    expect(names(load(cfg, base))).toEqual(["single:solo"]);
  });

  it("falls back to the default skills/ and commands/ layout without a manifest", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-default-"));
    const cfg = path.join(base, "cfg");
    const plain = plugin("plain", {
      "skills/one/SKILL.md": "---\ndescription: One plain plugin skill description\n---\n",
      "commands/cmd.md": "---\ndescription: One plain plugin command description\n---\n",
      "skills/notaskill/README.md": "no SKILL.md here\n",
    });
    registry(cfg, { "plain@mp": [{ scope: "user", installPath: plain }] });
    expect(names(load(cfg, base))).toEqual(["plain:cmd", "plain:one"]);
  });

  it("lists install paths of enabled plugins only", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-paths-"));
    const cfg = path.join(base, "cfg");
    const on = plugin("on", {});
    const off = plugin("off", {});
    registry(cfg, { "on@mp": [{ scope: "user", installPath: on }], "off@mp": [{ scope: "user", installPath: off }] }, { enabledPlugins: { "off@mp": false } });
    expect(pluginInstallPaths({ cwd: base, configDir: cfg })).toEqual([{ plugin: "on", installPath: on }]);
  });

  it("discovers source plugins by manifest name, basename fallback, collections, and symlink", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-source-"));
    const direct = plugin("direct", { ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }) });
    const collection = path.join(base, "collection");
    const second = plugin("second", { ".claude-plugin/plugin.json": JSON.stringify({ name: "second-name" }) });
    const unnamed = plugin("unnamed", { ".claude-plugin/plugin.json": JSON.stringify({}) });
    fs.mkdirSync(collection, { recursive: true });
    fs.symlinkSync(second, path.join(collection, "linked"), "dir");
    fs.cpSync(unnamed, path.join(collection, "unnamed"), { recursive: true });
    expect(sourcePlugins([direct, collection])).toEqual([
      { plugin: "p", installPath: direct },
      { plugin: "second-name", installPath: path.join(collection, "linked") },
      { plugin: "unnamed", installPath: path.join(collection, "unnamed") },
    ]);
  });

  it("loads source plugin skills and commands with descriptions", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-source-docs-"));
    const source = plugin("source", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
      "skills/skill/SKILL.md": "---\ndescription: skill description\n---\nbody\n",
      "commands/cmd.md": "---\ndescription: command description\n---\nbody\n",
    });
    const docs = loadSkillDocs({ cwd: base, configDir: path.join(base, "empty"), pluginDirs: [source] });
    expect(byName(docs, "p:skill")).toMatchObject({ plugin: "p", description: "skill description" });
    expect(byName(docs, "p:cmd")).toMatchObject({ plugin: "p", description: "command description" });
    expect(pluginInstallPaths({ cwd: base, configDir: path.join(base, "empty"), pluginDirs: [source] })).toContainEqual({ plugin: "p", installPath: source });
  });

  it("source plugin of the same name replaces its installed docs", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-source-replace-"));
    const cfg = path.join(base, "cfg");
    const installed = plugin("installed", { "skills/old/SKILL.md": "---\ndescription: installed\n---\n" });
    const source = plugin("source", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
      "skills/new/SKILL.md": "---\ndescription: source\n---\n",
    });
    registry(cfg, { "p@market": [{ scope: "user", installPath: installed }] });
    const docs = withConfig(cfg, () => loadSkillDocs({ cwd: base, pluginDirs: [source] }));
    expect(byName(docs, "p:new")?.description).toBe("source");
    expect(byName(docs, "p:old")).toBeUndefined();
  });

  it("skips disabled plugins and project/local scopes for other paths", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-scope-"));
    const cfg = path.join(base, "cfg");
    const off = plugin("off", { "skills/x/SKILL.md": "---\ndescription: A disabled plugin skill\n---\n" });
    const elsewhere = plugin("elsewhere", { "skills/y/SKILL.md": "---\ndescription: A skill from another project\n---\n" });
    const mine = plugin("mine", { "skills/z/SKILL.md": "---\ndescription: A skill for this very project\n---\n" });
    registry(cfg, {
      "off@mp": [{ scope: "user", installPath: off }],
      "elsewhere@mp": [{ scope: "project", projectPath: path.join(base, "somewhere-else"), installPath: elsewhere }],
      "mine@mp": [{ scope: "local", projectPath: base, installPath: mine }],
    }, { enabledPlugins: { "off@mp": false, "mine@mp": true } });
    expect(names(load(cfg, base))).toEqual(["mine:z"]);
  });

  it("treats unreadable registry or settings as no plugins and never throws", () => {
    base = fs.mkdtempSync(path.join(tmp, "plug-broken-"));
    const cfg = path.join(base, "cfg");
    const demo = plugin("demo", { "skills/ok/SKILL.md": "---\ndescription: Fine without settings file at all\n---\n" });
    registry(cfg, { "demo@mp": [{ scope: "user", installPath: demo }] });
    expect(names(load(cfg, base))).toEqual(["demo:ok"]); // missing settings = enabled
    writeFile(path.join(cfg, "settings.json"), "{ not json");
    expect(names(load(cfg, base))).toEqual(["demo:ok"]); // broken settings = enabled
    writeFile(path.join(cfg, "plugins", "installed_plugins.json"), "{{{");
    skill(cfg, "user-skill", "---\ndescription: user skill survives broken registry\n---\n");
    expect(names(load(cfg, base))).toEqual(["user-skill"]);
  });
});
