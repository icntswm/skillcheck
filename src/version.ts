import * as fs from "node:fs";

/** Package version, read from the package.json next to dist/ or src/. */
export function readVersion(): string {
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(url, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}
