import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gitIn, resolveGitSelection } from "@yrd/queue-core"

export type SelectedGitCall = Readonly<{ cwd: string; args: readonly string[]; marker?: string }>

/** A real native-delegating executable, shared by the CLI queue and service journeys. */
export async function installSelectedGit(repo: string) {
  const native = (await resolveGitSelection(repo)).executable
  const executable = join(repo, "..", "selected-git")
  const logPath = `${executable}.jsonl`
  writeFileSync(logPath, "")
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({cwd:process.cwd(), args, marker:process.env.YRD_SELECTED_TEST_MARKER})+"\\n");
const result = spawnSync(${JSON.stringify(native)}, args, {stdio:"inherit"});
if (result.error) throw result.error;
if (result.signal) throw new Error("native Git ended with " + result.signal);
if (result.status === null) throw new Error("native Git returned no exit status");
process.exit(result.status);
`,
    { mode: 0o700 },
  )
  await gitIn(repo)(["config", "yrd.git", JSON.stringify({ executable, contract: "native" })])
  return {
    executable,
    logPath,
    readCalls: (): readonly SelectedGitCall[] =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as SelectedGitCall),
  }
}
