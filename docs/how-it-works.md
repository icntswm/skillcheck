# How it works

## run

For every case and repeat, skillcheck starts

```
claude -p "<query>\n\n<stop directive>" --output-format stream-json
```

and reads the event stream:

1. The init event lists the skills the agent can load. Expected names that are
   not among them get a warning, so a renamed skill does not pass unnoticed.
2. Every `Skill` tool call is recorded as a loaded skill.
3. When the answer is known, meaning a skill was loaded or the model started
   writing text, skillcheck kills the process group. The rest of the turn is
   never paid for.

The stop directive asks the model to load a skill if one fits and then stop.
`--directive <file>` replaces it; `--no-early-stop` lets the agent finish its
turn, which costs more but shows what happens next.

The agent runs in plan mode with edits, shell, web, subagents and MCP tools
disallowed, so a run is safe to point at any project.

Runs go in parallel (`--jobs`, 4 by default). If the agent is not logged in or
the key is rejected, the whole run stops at the first such error instead of
failing every case the same way.

## run --batch

One call per chunk of up to 25 cases. The requests go into one prompt in plan
mode, and `--json-schema` makes the model answer with a list: request number
and the skills it would load. If the model loads a skill instead of answering,
the call is stopped and reported as an error.

## lint

No model calls. skillcheck reads skill and command descriptions from
`~/.claude` (or `CLAUDE_CONFIG_DIR` / `--config-dir`), the project's `.claude/`
and installed plugins, and builds a TF-IDF index over them. It reports:

- descriptions too short to route on;
- pairs of descriptions that look alike (`--overlap`);
- cases whose expected skill ranks low for the request's words (`--top`);
- skills no case covers.

Lint compares words, not meaning. A two-word description shares no words with
anything, so lint flags it as short but cannot see that it overlaps a
neighbour. It is a free hint; the model run is the proof.

## check, list, init

- `check` validates the suite and matches names against installed skills.
- `list` and `init` start `claude` and kill it right after the init event, so
  nothing reaches the model and nothing is billed, even when not logged in.

## Limits

- The model's choice is not deterministic. Use `--repeat` and `threshold` for
  cases near a border.
- A request in a real session comes with history and open files; skillcheck
  sends it cold. Routing in a long session can differ.
- Results depend on the model. Pin `model:` in the suite and rerun when you
  switch.
