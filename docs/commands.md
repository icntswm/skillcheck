# Commands

Every command and option in one place. `skillcheck --help` prints the same list
in short form, `skillcheck --version` the installed version.

| Command | What it does | Model calls |
|---|---|---|
| [`init`](#init) | writes a starter cases file listing your skills | none |
| [`gen`](#gen) | drafts cases from your skill descriptions | one per 8 skills |
| [`suggest`](#suggest) | proposes description fixes from routing failures | one per 8 skills |
| [`import`](#import) | turns a skill-creator trigger eval set into cases | none |
| [`check`](#check) | validates the cases file | none |
| [`lint`](#lint) | static checks on descriptions and cases | none |
| [`list`](#list) | prints the skills and commands Claude Code sees | none |
| [`run`](#run) | runs the cases and reports which skills loaded | one per case, or one per 25 with `--batch` |

`[file]` is the cases file. Without it, `run`, `check` and `lint` look for
`skillcheck.yaml`, `skillcheck.yml` or `skillcheck.json` in the current
directory, and `init` writes `skillcheck.yaml`. The format is
in [Writing cases](writing-cases.md).

## Where skills come from

skillcheck reads skills the way Claude Code does: the user config
(`~/.claude`, or `CLAUDE_CONFIG_DIR`), the project's `.claude/`, and installed
plugins, whose skills are named `plugin:skill`.

`--config-dir <dir>` replaces the user config directory. `check`, `lint` and
`gen` read skills from it; `run`, `list` and `init` also start Claude Code with
it. Use it to test only the skills of a repository, without whatever else is
installed on the machine:

```
mkdir -p .skillcheck/skills
cp -R skills/. .skillcheck/skills/
skillcheck run --config-dir .skillcheck
```

A fresh config directory is not logged in: set `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` made by `claude setup-token`.

## init

```
skillcheck init [file] [--force] [-a <agent>] [--timeout <sec>] [--config-dir <dir>]
```

Writes `skillcheck.yaml` (or `file`) listing the skills Claude Code sees, as a
starting point: add two or three real requests per skill. It starts `claude`
and kills it right after its init event, so nothing is billed, even when not
logged in. `--force` overwrites an existing file.

## gen

```
skillcheck gen [--skill a,b | --plugin <name>] [--per-skill <n>] [-o <file> [--force] | --append <file>]
               [-m <model>] [-j <n>] [--timeout <sec>] [--config-dir <dir>]
```

Asks the model to draft requests for each skill: ones that should load it and
near misses that should not. One call per eight skills, about the price of one
batch call each. The result is a draft to review; see
[Drafting cases with gen](writing-cases.md#drafting-cases-with-gen).

| Option | Meaning |
|---|---|
| `--skill a,b` | draft for these skills (default: your user and project skills) |
| `--plugin <name>` | draft for the skills of this installed plugin |
| `--per-skill <n>` | requests that should load each skill (default 4); near misses are half that |
| `-o, --out <file>` | write the cases there instead of stdout, as JSON if the name ends in `.json`; `--force` overwrites |
| `--append <file>` | add the draft to an existing cases file: by default only for skills it has no cases for, skipping requests it already has, keeping its comments |

## suggest

```
skillcheck suggest <report.json> [--skill a,b] [-m <model>] [-j <n>] [--timeout <sec>]
                         [--config-dir <dir>] [--plugin-dir <dir>] [--json <path>|-]
```

Reads a report made by `skillcheck run --json`, finds confused skills with
descriptions on disk, and asks the model for bounded description edits. Review
the suggestions, edit the descriptions, then rerun `skillcheck run` to confirm.
Nothing is written to your files.

The model sees the failing requests, what loaded instead, and up to five passing
requests per skill that must keep working. Runs that errored or that the report
diagnosed as a model limit are left out, and so are skills the agent could not
see in that run: those need a setup fix, not a new description. The old text
shown includes `when_to_use` when the skill has it; the suggestion is one
`description` to replace both.

A better description is not always enough. When the agent can answer a request
on its own, such as running `git log` for a question about history, it may
skip the skill whatever the description says; the rerun shows whether the edit
helped.

| Option | Meaning |
|---|---|
| `--skill a,b` | suggest only these skills |
| `-m, --model <name>` | model passed to the agent |
| `-j, --jobs <n>` | concurrent groups of up to eight skills |
| `--timeout <sec>` | per-call timeout |
| `--config-dir <dir>` | config directory containing skill descriptions |
| `--plugin-dir <dir>` | plugin source directory; repeatable |
| `--json <path>` | write machine-readable suggestions; `-` writes JSON to stdout and terminal text to stderr |

## import

```
skillcheck import <eval_set.json> --skill <name> [-o <file> [--force]]
```

Converts a trigger eval set from Anthropic's skill-creator, a JSON list of
`{query, should_trigger}` for one skill: `true` becomes `expect`, `false`
becomes `forbid`. Without `-o` the cases go to stdout. See
[From skill-creator](writing-cases.md#from-skill-creator).

## check

```
skillcheck check [file] [--skill a,b] [--no-name-check] [--config-dir <dir>]
```

Validates the cases file and warns about skill names it cannot find among the
installed skills, which catches typos and renamed skills. Plugin skills
(`plugin:skill`) are not matched: a typo there shows up only in `run`.
`--no-name-check` skips the name check, for a file written on another machine.
`--skill` checks only the cases that mention those skills.

## lint

```
skillcheck lint [file] [--top <n>] [--overlap <x>] [--strict] [--config-dir <dir>]
```

Reads the descriptions from disk and reports, without any model call:

- descriptions too short to route on;
- pairs of descriptions that look alike (`--overlap`, similarity from 0 to 1,
  default 0.3);
- cases whose expected skill ranks below `--top` (default 5) for the words of
  the request;
- skills no case covers.

Without a cases file it checks only the descriptions. It exits 0 either way;
`--strict` makes it exit 1 when it finds short, look-alike or low-ranked ones,
for a CI gate. Lint compares words, not meaning: a free hint, not a proof. See
[How it works](how-it-works.md#lint).

## list

```
skillcheck list [-a <agent>] [--timeout <sec>] [--config-dir <dir>]
```

Prints the skills and slash commands Claude Code can load, as it reports them
at start. Free, like `init`.

## run

```
skillcheck run [file] [options]
```

Sends each request to Claude Code and checks which skills it loads. Options by
purpose:

**What to run**

| Option | Meaning |
|---|---|
| `--only 3,cart-flaky` | only these cases, by number or `id` |
| `--skill a,b` | only the cases that mention these skills |

**How to run**

| Option | Default | Meaning |
|---|---|---|
| `-a, --agent <name>` | suite, or `claude` | agent that routes the requests |
| `-m, --model <name>` | suite, or the agent's | model passed to the agent |
| `--repeat <n>` | suite, or 1 | runs per case |
| `--threshold <x>` | suite, or 1 | share of runs a case must pass, above 0 and up to 1 |
| `-j, --jobs <n>` | 4 | runs at the same time |
| `--timeout <sec>` | 180 | limit per run |
| `--batch` | | one call per chunk of cases: the model *states* its choice instead of making it; cheap, but a lead rather than a proof |
| `--batch-size <n>` | 25 | cases per batch call; needs `--batch` |
| `--directive <file>` | | replace the stop directive sent with every request; not with `--batch` |
| `--no-early-stop` | | let the agent finish its turn instead of stopping it once a skill is picked; costs more; not with `--batch` |
| `--budget <usd>` | | stop starting new runs once the spend estimate reaches this; the rest is reported as skipped |
| `--config-dir <dir>` | | see [Where skills come from](#where-skills-come-from) |
| `--plugin-dir <dir>` | | load a plugin from source for this session; repeatable |

**Reports**

| Option | Meaning |
|---|---|
| `--json <path>` | every case, run, verdict and cost; `-` writes it to stdout and the terminal report to stderr |
| `--junit <path>` | JUnit XML for GitLab and GitHub test reports |
| `--markdown <path>` | a summary for a pull request comment or job summary |
| `--baseline <path>` | an earlier `--json` report: marks each case regressed, fixed or new |
| `--only-new-failures` | with `--baseline`: exit 1 only for regressed or new failing cases, or cases the budget skipped |
| `--cache <path>` | reuse passed results whose case, skills and model did not change; updated after the run; not with `--batch` |

What the reports contain and how to compare with `main` in CI:
[Reports and CI](ci.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | all cases passed (`lint`: always, unless `--strict` finds something; `gen`, `suggest`: done, even with nothing to suggest) |
| 1 | some case failed or was skipped by the budget |
| 2 | config or environment error, or the agent cannot run (not logged in) |

With `--only-new-failures`, a case that already failed in the baseline does
not count: the run exits 0 if nothing regressed, no new case fails and the
budget skipped nothing.
