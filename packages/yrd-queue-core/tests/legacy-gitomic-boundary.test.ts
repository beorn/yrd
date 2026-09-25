import { readFileSync, readdirSync } from "node:fs"
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
    // Source-text checks are invisible to import-based test selection. Enumerate
    // every ref-command site so a new site requires an explicit boundary review.
    const sites = Object.fromEntries(
      readdirSync(new URL("../src/", import.meta.url))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => [name, refCommands(source(name))] as const)
        .filter(([, commands]) => commands.length > 0),
    )
    expect(sites).toEqual({
      // The host mirror's own `fetch --prune` (25570 row 1): it refreshes a store of hosted repositories and reads
      // or writes no queue ref.
      "mirror.ts": ["fetch"],
      "override.ts": ["push", "push"],
      "publication.ts": ["push"],
      "reference.ts": ["update-ref", "fetch", "ls-remote"],
      "settled-base.ts": ["fetch"],
      "submit.ts": ["fetch", "push"],
    })

    for (const name of ["git.ts", "legacy-records.ts", "pause.ts", "remote.ts", "withdraw.ts"]) {
      expect(refCommands(source(name)), name).toEqual([])
    }

    const submit = source("submit.ts")
    const [gitlinkPublication, queueSubmission] = submit.split("export type SubmitInspection")
    // The retention ref is read by name through readRemoteCommit (25570), never an ls-remote.
    expect(refCommands(gitlinkPublication ?? ""), "gitlink retention publication").toEqual(["fetch", "push"])
    expect(refCommands(queueSubmission ?? ""), "legacy queue submission").toEqual([])

    // The run's one fetch (the composing checkout's commit) lives in settled-base.ts.
    const run = source("run.ts")
    expect(refCommands(run), "queue run").toEqual([])
    expect(run).toContain("publishCheckedChildren(")
    const settledBase = source("settled-base.ts")
    expect(refCommands(settledBase), "settled base").toEqual(["fetch"])
    expect(settledBase).toContain('await options.git(["fetch", "--quiet", composing.path, commit])')

    const publication = source("publication.ts")
    // This marker read-back is a format-agnostic ref-level check shared by both
    // adapters per 25040 §3; 25041 removes the legacy call, not this module. It
    // reads the marker by name through the seam's readRemoteCommit (25570).
    expect(refCommands(publication), "shared child publication").toEqual(["push"])
    expect(publication).toContain("readRemoteCommit(options.git, options.remote, options.marker.ref)")
    expect(publication).toContain('["push", "--recurse-submodules=only", options.remote')
  })

  it("imports Gitomic only through the configured git seam", () => {
    const modules = ["yrd-queue-core", "yrd-cli"].flatMap((name) => {
      const directory = new URL(`../../${name}/src/`, import.meta.url)
      return readdirSync(directory, { recursive: true })
        .filter((path) => /\.[cm]?[jt]sx?$/u.test(String(path)))
        .map((path) => ({
          path: `${name}/${String(path)}`,
          text: readFileSync(new URL(String(path), directory), "utf8"),
        }))
    })
    const imports = modules
      .filter(({ text }) => /(?:from|import\s*\()\s*["']gitomic(?:\/[^"']*)?["']/u.test(text))
      .map(({ path }) => path)
    expect(imports).toEqual(["yrd-queue-core/git.ts"])
    expect(source("git.ts").match(/createShellBackend\(/gu)).toHaveLength(1)
    expect(source("git.ts")).toContain("backend: GitomicBackend = createLegacyBackend(selection.executable)")
  })

  it("selects Yrd's scrubbed environment and five-minute bound for both production paths", () => {
    const git = source("git.ts")
    expect(git).toContain("const GIT_ROOT_INVOCATION_MS = 5 * 60_000")
    // Bound once, so the publickey retry (25282) resolves its SSH command from attempt 1's environment.
    expect(git).toContain("const baseEnv = gitEnvironment(globalThis.process.env)")
    expect(git).toContain("remoteTimeoutMs: GIT_ROOT_INVOCATION_MS")
    expect(git).toContain("gitExecutable,")
    expect(source("legacy-records.ts")).toContain("createLegacyBackend(executableFor(git))")
    expect(source("events.ts")).toContain("backend: GitomicBackend")
  })
})
