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

- `--json report.json`: every case, run, verdict and cost. `--json -` writes
  it to stdout and moves the terminal report to stderr.
- `--junit skillcheck.xml`: JUnit XML that GitLab and GitHub show as a test
  report. A misrouted case is a failure, a case where every run errored is an
  error, a case skipped by `--budget` is skipped.
- `--markdown report.md`: a short summary for a pull request comment or a job
  summary: a header with the counts, a table of the failed and skipped cases,
  the passed ones folded, and the confusion block.

Exit codes and every other option: [Commands](commands.md). To run only the
skills of a repository, not the ones installed on your machine, see
[`--config-dir`](commands.md#where-skills-come-from); the action below does
this for you.

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
| `cache` | | path of a result cache file for `--cache`; empty disables it |
| `junit` | `skillcheck.xml` | JUnit report path, empty disables it |
| `args` | | extra arguments for `skillcheck run`, split on whitespace: quotes are not parsed, so a path with spaces does not fit |
| `comment` | `true` | post the report as a pull request comment |
| `github-token` | `github.token` | token for that comment |
| `version` | `latest` | skillcheck version to install |
| `claude-code-version` | `latest` | Claude Code version to install |

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

`--baseline report.json` compares a run with an earlier JSON report and marks
each case regressed, fixed or new. `--only-new-failures` then exits 1 only for
regressed or new failing cases, or cases the budget skipped. A case the
baseline skipped counts as new; cases left out by `--only` or `--skill` do not
count as removed.

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
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
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
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    baseline: skillcheck-baseline.json
    args: --only-new-failures
```

Caches of the default branch are visible to pull requests. Until the first
baseline is saved, the action runs without the comparison and ignores
`--only-new-failures`, so every failure counts. After that, a known failure
does not block unrelated pull requests, but it still shows in the comment.

### Reusing results

`--cache <file>` (the action's `cache` input) skips a case that passed before
when nothing that affects its routing changed: the case itself, the frontmatter
of any skill or command, `CLAUDE.md` files, the model, the timeout, the agent
and its version. It does not work with `batch: true`. Failed and skipped cases
always run again. Reused cases are marked cached and cost nothing; the report shows what the cache saved.

Editing a skill's body (everything after the frontmatter) does not invalidate
the cache, since only descriptions and other frontmatter affect routing.
Editing any description, installing a plugin, or using a new Claude Code
version reruns everything; the action installs the latest version by default,
so pin it with `claude-code-version` when needed. If the version cannot be read,
nothing is reused and the cache file is left as is. The agent's default model
is not part of the key: pin the model (`model` input, `--model` or the suite's
`model`) when you use the cache.

```yaml
- uses: actions/cache/restore@v4
  with:
    path: skillcheck-cache.json
    key: skillcheck-cache-${{ github.run_id }}-${{ github.run_attempt }}
    restore-keys: skillcheck-cache-
- uses: icntswm/skillcheck@v1
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    cache: skillcheck-cache.json
- if: always()
  uses: actions/cache/save@v4
  with:
    path: skillcheck-cache.json
    key: skillcheck-cache-${{ github.run_id }}-${{ github.run_attempt }}
```

The key uses `run_id` and `run_attempt`, so every run, a rerun too, saves a
fresh cache. The `restore-keys`
prefix picks the most recent cache available to the branch; pull requests can
also read caches from the default branch.

A failing case fails the step, so a step that reads the outputs needs
`if: always()`. `skillcheck.xml` still works with `actions/upload-artifact`
or a JUnit reporter action.

### Testing a plugin

Set the action's `plugin-dir` input to a plugin source directory. When it is
empty, the action auto-detects `.claude-plugin/plugin.json` at the repository
root. Plugin mode uses an empty isolated config directory, and cases refer to
skills as `plugin:skill`. The `skills-dir` input is ignored in plugin mode.

```yaml
- uses: icntswm/skillcheck@v1
```

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
