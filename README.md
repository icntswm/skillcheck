# skillcheck

**Regression tests for Claude Code skills.** Did your last edit to a skill
description quietly send requests to the wrong skill? skillcheck tells you
before your users do.

```
$ skillcheck run examples/demo/skillcheck.yaml --skill test-guard,find-bug
5 cases × 1 repeat × 1 agent = 5 runs
ok    #bug-500  POST /orders returns 500 with 'nil pointer deref…  → find-bug
FAIL  #flaky-ci-only  this test is red in CI roughly once a day but I …  → find-bug · not loaded test-guard
FAIL  #flaky-retry  TestCartMerge fails sometimes and goes green w…  → find-bug · not loaded test-guard; forbidden find-bug
ok    #bug-consistent  TestCheckoutTotal fails on every run since this …  → find-bug
ok    #perf-latency  the /search endpoint went from 80ms to 900ms aft…  → perf-profile

confusion:
  expected test-guard → got find-bug (2)
2 failed of 5 · runs 5 · cost $0.25
```

That is a real run. Someone widened one skill's description, and it started
taking requests that belong to its neighbour.

## Why

Claude Code picks a skill by reading the names and descriptions of every skill
you have. Nothing warns you when that choice changes, and it changes when you:

- rewrite or shorten a description;
- add a skill whose description overlaps an old one;
- install a plugin that brings its own skills;
- switch to another model.

The failure is silent: the agent still answers, just with the wrong
instructions loaded. skillcheck turns "which skill should load for this
request" into a test suite you rerun after every change.

## How it works in one minute

You write requests the way you type them and say which skill must, or must
not, load:

```yaml
cases:
  - query: "why does TestOrderCreate fail? it was green yesterday"
    expect: [find-bug]
    forbid: [test-guard]
  - query: "what is 2 + 2?"
    none: true
```

skillcheck sends each request to a headless `claude -p`, watches which skills
the model loads, and stops the process as soon as the answer is known. Tools
that change anything are disabled, so a run never touches your files.

## Three levels, from free to exact

Every model call carries the full Claude Code system prompt, so checks are not
free. Start at the cheapest level and go up only when it finds nothing.

| Command | Model calls | What it tells you |
|---|---|---|
| `skillcheck lint` | none | short descriptions, look-alike skills, cases whose expected skill shares few words with the request |
| `skillcheck run --batch` | one per 25 cases | which skill the model *says* it would load |
| `skillcheck run` | one per case | which skill the model *actually* loads |

On the demo suite one batch call covered all 12 cases for $0.05 and agreed
with the normal run in 34 checks out of 34. More in [docs/cost.md](docs/cost.md).

## Does it really catch regressions?

[examples/demo](examples/demo) has six skills, twelve cases and a bad edit of
two descriptions. With the good skills every case passes. With the bad edit,
both `run --batch` and a normal run catch the same two misrouted cases. The
recorded results, and the edits that did *not* break routing, are in
[its README](examples/demo/README.md).

## Install

Needs Node 20+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
(`claude`) in `PATH`, logged in.

```
git clone https://github.com/icntswm/skillcheck
cd skillcheck
npm install && npm run build && npm link
```

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

- [Writing cases](docs/writing-cases.md): the file format and what makes a
  case catch regressions.
- [Cost](docs/cost.md): what a run costs and how to spend less.
- [Reports and CI](docs/ci.md): the confusion block, JSON, JUnit, GitHub
  Actions, exit codes.
- [How it works](docs/how-it-works.md): what happens inside a run, and the
  limits of each level.
- `skillcheck --help`: every command and option.

## Status

Works with Claude Code. Agents are behind a small adapter interface, so
others that support skills can be added.

## License

MIT
