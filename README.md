# skillcheck

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@icntswm/skillcheck.svg)](https://www.npmjs.com/package/@icntswm/skillcheck)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)

**Regression tests for Claude Code skills.**

You edited a skill description, installed a plugin or switched models, and now
some of your requests load the wrong skill. Nothing warns you: the agent still
answers, just with the wrong instructions. skillcheck catches this before your
users do.

![skillcheck catching a routing regression](docs/assets/demo.gif)

A real run on the [demo](examples/demo): one skill's description got wider,
and it started taking requests that belong to its neighbour. The free `lint`
flags a suspicious description, and one batch call finds the two misrouted
requests.

## What you get

- 🎯 **The real routing decision.** skillcheck runs Claude Code itself and reads
  which skills the model actually loads. Nothing is simulated or guessed from
  keywords.
- 💸 **Cheap by design.** Free static checks first. Then one batch call covers
  25 requests. A full run stops Claude Code the moment it picks a skill, so
  you pay for the decision, not for the work.
- 🔍 **Points at the fix.** The confusion block shows which skill took whose
  requests. When the model names the right skill but doesn't load it, the
  report says so separately.
- 🛡️ **Safe on any project.** Runs go in plan mode with edits, shell, web and
  MCP tools disabled. Your files are never touched.
- 🧪 **Honest about randomness.** `--repeat` and `threshold` tell a flaky case
  from a broken one instead of letting you guess.
- 🏷️ **Catches renames and typos.** Case names are checked against the skills
  the agent really has, so a renamed skill can't pass silently.
- ⚙️ **CI-ready.** A GitHub Action (`uses: icntswm/skillcheck@v1`), JUnit
  and JSON reports, clear exit codes, a spending cap (`--budget`), and
  `--config-dir` to test only the skills in your repository.
- 📄 **Plain YAML, one dependency.** Cases are readable by anyone on the team
  and live next to the skills they test.

## When to run it

- after you rewrite or shorten a skill description;
- when you add a skill that sounds like an existing one;
- after installing a plugin that brings its own skills;
- before switching to another model;
- on every pull request that touches `skills/`.

## How it works in one minute

Write requests the way you actually type them, and say which skill must, or
must not, load:

```yaml
cases:
  - query: "why does TestOrderCreate fail? it was green yesterday"
    expect: [find-bug]
    forbid: [test-guard]
  - query: "what is 2 + 2?"
    none: true
```

skillcheck sends each request to a headless `claude -p`, watches which skills
the model loads, and stops the process as soon as the answer is clear.

## Three levels, from free to exact

Start at the cheapest level and go up only when it finds nothing.

| Command | Model calls | What it tells you |
|---|---|---|
| `skillcheck lint` | none | short descriptions, look-alike skills, cases whose expected skill shares few words with the request |
| `skillcheck run --batch` | one per 25 cases | which skill the model *says* it would load |
| `skillcheck run` | one per case | which skill the model *actually* loads |

On the demo suite one batch call covered all 12 cases for $0.05–0.10 and agreed
with the normal run in 34 checks out of 34. More in [docs/cost.md](docs/cost.md).

## Does it really catch regressions?

Yes, and the [demo](examples/demo) shows it: six skills, twelve cases and a bad
edit of two descriptions.

| | good skills | bad edit |
|---|---|---|
| `lint` | no problems | flags the too-short description |
| `run --batch` | 12/12 passed | catches both misrouted cases |
| `run` | 5/5 passed | catches the same two cases |

The demo README also lists edits that did *not* break routing, and why.

## Install

Needs Node 20+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
(`claude`) in `PATH`, logged in.

```
npm install -g @icntswm/skillcheck
```

The command is `skillcheck`. To try it without installing:
`npx @icntswm/skillcheck lint`.

## Quick start

```
skillcheck init              # writes skillcheck.yaml listing your skills
                             # then add a few real requests per skill
skillcheck check             # validates the file, no model calls
skillcheck lint              # free static checks
skillcheck run --batch       # cheap pre-check, one call
skillcheck run --only 2,5    # confirm what the batch flagged
```

`skillcheck list` prints the skills and slash commands Claude Code sees. It
stops Claude Code before the first model call, so it costs nothing.

## Documentation

| | |
|---|---|
| [Writing cases](docs/writing-cases.md) | the file format and what makes a case catch regressions |
| [Cost](docs/cost.md) | what a run costs and how to spend less |
| [Reports and CI](docs/ci.md) | confusion block, JSON, JUnit, GitHub Actions, exit codes |
| [How it works](docs/how-it-works.md) | what happens inside a run, and the limits of each level |

`skillcheck --help` lists every command and option.

## Status

Works with Claude Code. Agents sit behind a small adapter interface, so others
that support skills can be added.

Requests can be in any language: `run` asks the model itself. `lint` compares
words, so it is tuned for English and Russian, works roughly for other
languages that put spaces between words, and is of little use for Chinese,
Japanese or Korean.

## License

[MIT](LICENSE)
