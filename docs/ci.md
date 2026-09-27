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
- `--markdown report.md` writes a short summary for a pull request comment or
  a job summary: a header with the counts, a table of the failed and skipped
  cases, the passed ones folded, and the confusion block.
- `--baseline report.json` compares the run with an earlier JSON report.
- `--only-new-failures` exits 1 only for regressed or new failing cases; it requires `--baseline`.

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
    permissions:
      contents: read
      pull-requests: write  # for the report comment
    steps:
      - uses: actions/checkout@v4
      - uses: icntswm/skillcheck@v1
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
| `baseline` | | path to an earlier `--json` report to compare with |
| `junit` | `skillcheck.xml` | JUnit report path, empty disables it |
| `args` | | extra arguments for `skillcheck run`, split on whitespace: quotes are not parsed, so a path with spaces does not fit |
| `comment` | `true` | post the report as a pull request comment |
| `github-token` | `github.token` | token for that comment |
| `version` | `latest` | skillcheck version to install |

The report lands in the job summary and, on pull requests, in a comment. A
rerun edits that comment instead of adding a new one. Without
`pull-requests: write` the comment step only warns; pull requests from forks
never get that permission. Two jobs that both run the action on one pull
request share the comment, so turn `comment` off in all but one.

Outputs, for the steps after it:

| Output | Meaning |
|---|---|
| `passed`, `failed`, `skipped` | case counts |
| `cost` | spend in USD, with the estimate for runs that reported no cost |
| `json`, `markdown` | paths to the reports |

### Comparing with main

The workflow on `push` to `main` can save a baseline from the action output:

```yaml
on:
  push:
    branches: [main]
jobs:
  baseline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: skillcheck
        uses: icntswm/skillcheck@v1
      - if: always()
        run: cp "${{ steps.skillcheck.outputs.json }}" skillcheck-baseline.json
      - if: always()
        uses: actions/cache/save@v4
        with:
          path: skillcheck-baseline.json
          key: skillcheck-baseline-${{ github.sha }}
```

The pull request workflow restores that cache and passes it to the action:

```yaml
- uses: actions/cache/restore@v4
  with:
    path: skillcheck-baseline.json
    key: skillcheck-baseline-
    restore-keys: skillcheck-baseline-
- uses: icntswm/skillcheck@v1
  with:
    baseline: skillcheck-baseline.json
    args: --only-new-failures
```

Caches of the default branch are visible to pull requests. With `--only-new-failures`, a known failure does not block unrelated PRs, but it still shows in the comment.

A failing case fails the step, so a step that reads the outputs needs
`if: always()`. `skillcheck.xml` still works with `actions/upload-artifact`
or a JUnit reporter action.

### Only the skills a pull request touched

`--skill` keeps the cases that mention the given skills, so a pull request
can pay only for what it changed. Skills here live in `skills/<name>/`:

```yaml
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: changed
        env:
          BASE: ${{ github.base_ref }}
        run: |
          names=$(git diff --name-only "origin/$BASE...HEAD" -- skills/ | cut -d/ -f2 | sort -u | paste -sd, -)
          echo "skills=$names" >> "$GITHUB_OUTPUT"
      - if: steps.changed.outputs.skills != ''
        uses: icntswm/skillcheck@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          args: --skill ${{ steps.changed.outputs.skills }}
```

A change to another skill can still steal requests from an untouched one, so
run the whole suite on a schedule or before a release.

Without the action, [examples/github-actions.yml](../examples/github-actions.yml) runs on pull
requests that touch `skills/` or the suite: `lint` first (free), then `run`
with three repeats, a $5 budget and the JUnit report uploaded as an artifact.

Be careful with pull requests from forks. Skills and `.claude/` settings in a
PR are written by its author, and the job runs Claude Code with your key on
them. The example uses `pull_request`, which gives forks no secrets; do not
switch it to `pull_request_target`. Run the paid job only for trusted
branches or after a maintainer approves it, and take `.claude/` from the base
branch.
