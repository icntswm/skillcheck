# skillcheck

Regression tests for agent skill routing: the right skill loads for a query,
its neighbours don't.

You write a request and name the skill it should load. skillcheck sends the
request to Claude Code and checks which skills the model actually loaded. Run
it after you edit a skill description, add a new skill or install a plugin, to
catch "now `find-bug` wins where `test-guard` should".

```
$ skillcheck run
4 cases × 1 repeat × 1 agent = 4 runs
ok    #1  why does TestOrderCreate fail? it was green yest…  → find-bug
FAIL  #cart-flaky  TestCartMerge fails sometimes and goes green o…  → find-bug · not loaded any of [stability, test-guard]
ok    #3  add an index on orders.created_at without blocki…  → db-migrations
ok    #4  what is 2 + 2?  → —

1 failed of 4 · runs 4 · cost $0.21
```

(illustrative output)

## What it costs

Each model call carries the whole Claude Code system prompt, including every
skill description you have. That is the price of a check, not the length of
your request. On a subscription it comes out of your usage limits; with an API
key it is billed per token. A few dozen full runs can take a noticeable share
of a five-hour limit.

So skillcheck has three levels. Start with the cheapest one and go up only
when it finds nothing:

| Command | Model calls | What it tells you |
|---|---|---|
| `skillcheck lint` | none | short descriptions, skills whose descriptions look alike, cases whose expected skill shares few words with the query |
| `skillcheck run --batch` | one per 25 cases | which skill the model *says* it would load for each request |
| `skillcheck run` | one per case and repeat | which skill the model *actually* loads |

- **lint** is a word-overlap check (TF-IDF over the descriptions on disk). It
  does not know what the model will do, but the pairs it flags are the usual
  suspects for confusion. It is free, so run it on every change.
- **run --batch** puts up to 25 requests into one prompt and asks the model
  for a structured answer. The model sees its real skill list, but it states a
  choice instead of making one, and the two can differ. Treat a batch failure
  as a lead and confirm it with a normal run: the report prints the
  `--only` line for that. One batch call with sonnet and about 80 skills
  installed cost $0.14, roughly the price of a single normal run.
- **run** starts one headless `claude -p` per case and stops it as soon as the
  answer is clear (a Skill call or the first text). This is the real check.

Other ways to spend less:

- `--skill find-bug,test-guard` runs only the cases that mention those skills,
  which is what you want after editing one skill.
- `--only 3,cart-flaky` runs chosen cases.
- `--budget 2` stops starting new runs once the spend estimate reaches $2.
  Runs stopped early do not report a cost, so the estimate is a lower bound;
  the report says how many runs had no cost.
- `--repeat 3 --threshold 0.67` makes a result stable, and triples the price.
  Keep `repeat: 1` while iterating on descriptions.

## Does it work?

[examples/demo](examples/demo) has six skills, twelve cases and a broken edit
of two descriptions. On the good skills every case passes; on the broken ones
both `--batch` (one call, $0.05) and a normal run catch the same two misrouted
cases. The recorded output is in its README.

## Install

```
npm install -g skillcheck
```

Needs Node 20+ and Claude Code (`claude`) in `PATH`, logged in.

## Quick start

```
skillcheck init              # writes skillcheck.yaml with your skills listed
skillcheck check             # validates the file, no model calls
skillcheck lint              # free static checks
skillcheck run --batch       # cheap pre-check
skillcheck run --only 2,5    # confirm what the batch flagged
```

`skillcheck list` prints the skills and slash commands Claude Code sees. It
stops the process before the first model call, so it costs nothing.

## Cases

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
  - query: "what is 2 + 2?"
    none: true
```

| Field | Meaning |
|---|---|
| `query` | the user request (required) |
| `expect` | skills that must all be loaded |
| `expect_any` | at least one of these must be loaded |
| `forbid` | skills that must not be loaded |
| `first` | the skill that must be loaded first |
| `none` | no skill at all |
| `note` | free text, shown with failures |
| `id` | stable label for the report and `--only` |
| `repeat`, `threshold` | per-case override of the suite defaults |
| `agents` | limit the case to these agents |

Write queries the way you actually type them: short, with typos and the
project's jargon. Add a negative case for each skill, a request that sounds
close but must not load it. Those catch more regressions than positive ones.

## Reports

- The terminal report ends with a confusion block: which skill loaded where
  another one was expected. Pairs that show up there are the descriptions to
  rewrite.
- `--json report.json` (or `--json -`) writes a machine-readable report.
- `--junit skillcheck.xml` writes JUnit XML for GitLab and GitHub test views.

Exit codes: 0 all passed, 1 some case failed or was skipped by the budget,
2 config or environment error.

## Testing a repository's skills in CI

`--config-dir` points Claude Code at a separate config directory, so the run
sees the skills from the repository and not whatever is installed on the
machine. A fresh config directory is not logged in: set `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` (made by `claude setup-token`).

See [examples/github-actions.yml](examples/github-actions.yml): `lint` first,
then `run` with a budget, JUnit uploaded as an artifact.

Be careful with pull requests from forks. The skills and `.claude/` settings in
a PR are written by its author, and the job runs Claude Code with your key on
them. Run the paid job only for trusted branches or after a maintainer
approves it, and take `.claude/` from the base branch.

## How it works

- `run` starts `claude -p "<query>\n\n<stop directive>" --output-format
  stream-json`, reads the Skill tool calls from the stream and kills the
  process group once the answer is known. Tools that change anything are
  disallowed.
- `run --batch` uses `--json-schema` for the answer and plan mode. If the model
  loads a skill instead of answering, the call is stopped and reported as an
  error.
- `check` and `lint` read `~/.claude` (or `CLAUDE_CONFIG_DIR`), the project's
  `.claude/` and installed plugins; they never start the agent.

## License

MIT
