#!/usr/bin/env node
// Fake `claude` binary for adapter tests: prints a fixture stream and
// behaves according to the FAKE_* environment variables.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

if (process.env.FAKE_ARGS_OUT) {
  // write then rename: a test that polls for the file and kills this process
  // must never read it half-written
  const tmp = `${process.env.FAKE_ARGS_OUT}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      claudeProjectDir: process.env.CLAUDE_PROJECT_DIR ?? null,
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    }),
  );
  renameSync(tmp, process.env.FAKE_ARGS_OUT);
}

if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);

if (process.env.FAKE_FIXTURE) {
  for (const line of readFileSync(process.env.FAKE_FIXTURE, "utf8").split("\n")) {
    if (line !== "") process.stdout.write(line + "\n");
  }
}

// a stuck process that only SIGKILL ends
if (process.env.FAKE_IGNORE_TERM === "1") process.on("SIGTERM", () => {});

if (process.env.FAKE_HANG === "1") {
  // stay alive until killed: proves early stop / timeout actually kill the group
  setInterval(() => {}, 1000);
} else {
  // exitCode instead of exit(): stdout must reach the pipe before the process ends
  process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
}
