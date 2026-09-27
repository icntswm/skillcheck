# Cost

Each model call carries the whole Claude Code system prompt, including every
skill description you have installed. That, not the length of your request,
is the price of a check. On a subscription it comes out of your usage limits;
with an API key it is billed per token. A few dozen normal runs can take a
noticeable share of a five-hour limit.

## Measured numbers

All with sonnet.

| What | Cost |
|---|---|
| `lint`, `check`, `list`, `init` | free |
| one batch call, demo suite (6 skills, 12 cases) | $0.05 |
| one batch call, about 80 skills installed | $0.14 |
| one normal run, demo suite | about $0.05 per case |

A normal run stops Claude Code as soon as it loads a skill or starts
answering, so you pay for the routing decision and not for the work.

## Spending less

- **Go up the levels.** `lint` on every change, `run --batch` when lint is
  clean, a normal `run` only for what the batch flagged. The batch report ends
  with the `--only` line to confirm its failures.
- **Run only what you touched.** `--skill a,b` keeps the cases that mention
  those skills.
- **Set a budget.** `--budget 2` stops starting new runs once the spend
  estimate reaches $2. Runs stopped early report no cost, so the estimate is a
  lower bound; the report says how many runs had no cost.
- **Keep `repeat: 1` while iterating.** `--repeat 3` makes a result stable and
  triples the price. Use it in CI or when a case looks flaky.
- **Fewer installed skills make every call cheaper.** In CI, point
  `--config-dir` at a directory with only the skills under test (see
  [ci.md](ci.md)).

## Why the batch is cheap and why it is not the final word

`run --batch` puts up to 25 requests into one prompt and asks the model for a
structured answer: which skill would it load for each. The model sees its real
skill list, but it *states* a choice instead of *making* one, and the two can
differ. On the demo they matched every time, but treat a batch failure as a
lead and a batch pass as a good sign, not a proof.
