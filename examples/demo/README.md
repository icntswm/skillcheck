# Demo: does skillcheck catch a routing regression?

Six made-up skills in `skills/`. Two of them are close on purpose: `find-bug`
(a test or endpoint fails every time) and `test-guard` (a test fails only
sometimes). `skillcheck.yaml` has 12 cases, two of which must load no skill.

`broken/` is an edit that breaks routing the way it happens in real configs:
someone widened `find-bug` to "any problem with tests, including tests that
fail only sometimes", and `test-guard` lost its description ("Helps with
tests.").

## Try it

```
mkdir -p /tmp/demo-good/skills /tmp/demo-broken/skills
cp -R examples/demo/skills/. /tmp/demo-good/skills/
cp -R examples/demo/skills/. /tmp/demo-broken/skills/
cp -R examples/demo/broken/. /tmp/demo-broken/skills/

skillcheck lint examples/demo/skillcheck.yaml --config-dir /tmp/demo-broken
skillcheck run examples/demo/skillcheck.yaml --batch --config-dir /tmp/demo-broken --json report.json
skillcheck suggest report.json --config-dir /tmp/demo-broken
skillcheck run examples/demo/skillcheck.yaml --skill test-guard,find-bug --config-dir /tmp/demo-broken
```

The copies keep Claude Code from writing into the repository. A separate
config dir has no login of its own: set `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).

## Results

Claude Code with sonnet, recorded on 2026-09-27. Costs are what the runs
reported.

| | good skills | broken edit |
|---|---|---|
| `lint` (no model) | no problems found | `test-guard` description too short (17 chars) |
| `run --batch` (1 call) | 12/12 passed, $0.05 | 10/12, both `test-guard` cases went to `find-bug`, $0.05 |
| `run --skill test-guard,find-bug` (5 calls) | 5/5 passed, $0.25 | 3/5, same two cases, $0.25 |

The broken run, as printed:

```
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

Wherever a case ran both ways, the batch answer matched the real Skill call:
34 of 34 across four configurations.

lint flagged the short description but not the overlap: it compares words,
and a two-word description shares none with its neighbour. It is a free hint,
the model run is the proof.

## What did not break routing

Two weaker edits passed, and skillcheck was right to pass them:

- Cutting a skill's description to "Helps with tests." while its name still
  said what it was for: the name alone matched the requests.
- The same cut with the neutral name `test-guard`: `find-bug` said "fails
  every time", so the model sent flaky requests to the only other test skill.

Routing broke only when the neighbour started claiming the same requests.
A precise description protects its neighbours too; a broad one takes their
work. Write cases for pairs like this, with `forbid` on the neighbour.
