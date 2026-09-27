# Reports and CI

## Terminal report

One line per case: `ok` or `FAIL`, the id, the start of the request, the skills
that loaded, and the reason for a failure. A failure where the model named the
skill in its text but did not load it gets a separate diagnosis: the
description is probably fine, the model just chose to answer directly.

The report ends with a **confusion block**:

```
confusion:
  expected test-guard → got find-bug (2)
```

Pairs that show up there are the descriptions to rewrite. Usually the fix is
to narrow the skill on the right, not to widen the one on the left.

## Machine-readable reports

- `--json report.json` writes every case, run, verdict and cost. `--json -`
  writes it to stdout and moves the terminal report to stderr.
- `--junit skillcheck.xml` writes JUnit XML that GitLab and GitHub show as a
  test report. A misrouted case is a failure, a case where every run errored
  is an error, a case skipped by `--budget` is skipped.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | all cases passed |
| 1 | some case failed or was skipped by the budget |
| 2 | config or environment error, or the agent cannot run (not logged in) |

## Testing a repository's skills

Your machine has its own skills and plugins, and they compete with the ones
under test. `--config-dir` points Claude Code at a separate config directory,
so a run sees only the skills you put there:

```
mkdir -p .skillcheck/skills
cp -R skills/. .skillcheck/skills/
skillcheck run --config-dir .skillcheck
```

A fresh config directory is not logged in. Set `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` made by `claude setup-token`.

## GitHub Actions

The shortest way is the skillcheck action. It installs Claude Code and
skillcheck, copies `skills/` into an isolated config dir, runs `lint` and then
`run`:

```yaml
on:
  pull_request:
    paths: [skills/**, skillcheck.yaml]

jobs:
  skillcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: icntswm/skillcheck@v0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: sonnet
          budget: 2
```

| Input | Default | Meaning |
|---|---|---|
| `file` | `skillcheck.yaml` | cases file |
| `skills-dir` | `skills` | skills under test; empty uses the runner's config |
| `lint` | `true` | run the free lint first |
| `run` | `true` | run the cases against the model |
| `batch` | `false` | one call per 25 cases |
| `model`, `repeat`, `threshold` | suite values | overrides |
| `budget` | `5` | spending cap in USD |
| `junit` | `skillcheck.xml` | JUnit report path, empty disables it |
| `args` | | extra arguments for `skillcheck run` |
| `version` | `latest` | skillcheck version to install |

To see the report in the pull request, upload `skillcheck.xml` with
`actions/upload-artifact` or feed it to a JUnit reporter action, with
`if: always()` so it runs when cases fail.

Without the action, [examples/github-actions.yml](../examples/github-actions.yml) runs on pull
requests that touch `skills/` or the suite: `lint` first (free), then `run`
with three repeats, a $5 budget and the JUnit report uploaded as an artifact.

Be careful with pull requests from forks. Skills and `.claude/` settings in a
PR are written by its author, and the job runs Claude Code with your key on
them. The example uses `pull_request`, which gives forks no secrets; do not
switch it to `pull_request_target`. Run the paid job only for trusted
branches or after a maintainer approves it, and take `.claude/` from the base
branch.
