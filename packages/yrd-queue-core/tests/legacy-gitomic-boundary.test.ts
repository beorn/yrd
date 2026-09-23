import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const REF_COMMAND = /\[\s*"(ls-remote|for-each-ref|update-ref|fetch|push)"/gu

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")
}

function refCommands(text: string): string[] {
  return [...text.matchAll(REF_COMMAND)].map((match) => match[1] ?? "")
}

describe("the legacy Gitomic boundary", () => {
  it("owns every legacy queue ref read and write", () => {
    for (const name of ["git.ts", "legacy-records.ts", "pause.ts", "remote.ts", "withdraw.ts"]) {
      expect(refCommands(source(name)), name).toEqual([])
    }

    const submit = source("submit.ts")
    const [gitlinkPublication, queueSubmission] = submit.split("export type SubmitInspection")
    expect(refCommands(gitlinkPublication ?? ""), "gitlink retention publication").toEqual([
      "fetch",
      "ls-remote",
      "push",
    ])
    expect(refCommands(queueSubmission ?? ""), "legacy queue submission").toEqual([])

    const run = source("run.ts")
    expect(refCommands(run), "queue run").toEqual(["fetch", "push"])
    expect(run).toContain('await run.git(["fetch", "--quiet", composing.path, commit])')
    expect(run).toContain('["push", "--recurse-submodules=only", target.remote')
  })
})
