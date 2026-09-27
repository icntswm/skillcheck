# Writing cases

A suite is a YAML (or JSON) file, `skillcheck.yaml` by default. `skillcheck
init` writes a starter file with the skills Claude Code sees on your machine.

```yaml
agent: claude
model: sonnet
repeat: 1
threshold: 1.0
cases:
  - query: "why does TestOrderCreate fail? it was green yesterday"
    expect: [find-bug]
    forbid: [test-guard]
  - query: "TestCartMerge fails sometimes and goes green on retry"
    expect_any: [stability, test-guard]
    id: cart-flaky
  - query: "add an index on orders.created_at without blocking writes"
    expect: [db-migrations]
    forbid: [find-bug]
  - query: "what is 2 + 2?"
    none: true
    note: "plain arithmetic must not trigger any skill"
```

## Suite fields

| Field | Default | Meaning |
|---|---|---|
| `agent` | `claude` | agent that routes the requests |
| `model` | agent's default | model passed to the agent |
| `repeat` | `1` | runs per case |
| `threshold` | `1.0` | share of runs a case must pass |

## Case fields

| Field | Meaning |
|---|---|
| `query` | the user request (required) |
| `expect` | skills that must all be loaded |
| `expect_any` | at least one of these must be loaded |
| `forbid` | skills that must not be loaded |
| `first` | the skill that must be loaded first |
| `none` | no skill at all |
| `note` | free text, shown next to failures |
| `id` | stable label for the report and `--only` |
| `repeat`, `threshold` | per-case override of the suite defaults |
| `agents` | limit the case to these agents |

A case needs at least one of `expect`, `expect_any`, `forbid`, `first`,
`none`. `skillcheck check` validates the file and warns about skill names it
cannot find among your installed skills (typos are the most common failure).

## What makes a good case

**Use real requests.** Copy them from your history: short, with typos and your
project's jargon. A polished request that repeats the description word for
word passes every time and proves nothing.

**Test the border, not the centre.** Regressions happen between two skills
that sound alike. For each such pair, write requests that belong to one side
and `forbid` the other:

```yaml
  - query: "this test is red in CI once a day but passes locally"
    expect: [test-guard]
    forbid: [find-bug]
```

**Add negative cases.** A request that sounds close to a skill but must not
load it, or must load nothing (`none: true`). These catch a description that
grew too broad, which is the most common way routing breaks.

**Few cases per skill are enough.** Two or three per skill, more for crowded
areas. Every case costs a model call in a normal run.

## Flaky routing

The model does not always choose the same way. When a case passes and fails
on reruns, measure it instead of guessing:

```
skillcheck run --only cart-flaky --repeat 5
```

Then either fix the descriptions or accept it with a threshold:
`repeat: 3, threshold: 0.67` on that case tolerates one miss in three.

## Drafting cases with gen

`skillcheck gen` asks the model to draft positive requests and near misses from
your installed skill descriptions. It makes one call per eight skills, at
about the price of one batch call per group. The result is only a draft: review
every case, remove guesses, and add real phrasings from your request history,
because generated requests tend to be cleaner than real ones.

## From skill-creator

Anthropic's skill-creator tunes a description against a trigger eval set: a
JSON list of requests marked `should_trigger: true` or `false`. skillcheck
checks triggering the same way, through `claude -p` with your real skill
list, so that set makes a ready suite to keep the tuned description from
regressing:

```
skillcheck import eval_set.json --skill pdf-forms -o skillcheck.yaml
```

`should_trigger: true` becomes `expect`, `false` becomes `forbid`: another
skill may load on those requests, only this one must not. Without `-o` the
suite goes to stdout, so it can be merged into an existing file by hand.

## Running a subset

- `--skill find-bug,test-guard`: only the cases that mention those skills,
  which is what you want after editing one skill.
- `--only 3,cart-flaky`: chosen cases by number or `id`.
