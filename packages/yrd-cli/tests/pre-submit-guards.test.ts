/**
 * @failure A pre-submit guard runs too late, too often, or swallows the diagnostic that tells the author what to fix.
 * @level l3
 * @consumer @yrd/cli pre-submit guards
 *
 * The bead these tests come from (@yrd/core/21679/21972) is about one measured
 * cost: an over-budget bead H1 was caught by a required check, so the author
 * learned about a twelve-character trim roughly two minutes after submitting,
 * having already consumed a queue slot. A guard has to move that verdict to
 * before the revision exists — which makes ORDER and SKIPPING the behaviour
 * under test, not incidental plumbing.
 */
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProcess, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { configuredChecks, configuredGuards } from "../src/host.ts"
import { parseYrdConfig, type ResolvedYrdProjectConfig } from "../src/config.ts"
import { guardScopedPaths } from "../src/pre-submit-guard-scope.ts"

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/**
 * A repository shaped like the one the bead is about: bead bodies under an
 * `@`-rooted state directory beside ordinary code, so "the candidate changed a
 * bead" and "the candidate changed only code" are both reachable.
 */
async function beadRepository(): Promise<{ repo: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-guard-"))
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await mkdir(join(repo, "@yrd", "core"), { recursive: true })
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, "@yrd", "core", "21000-short.md"), "# a short title\n")
  await git(repo, "add", "README.md", "@yrd")
  await git(repo, "commit", "-qm", "main")
  const stateDir = join(repo, ".git", "yrd")
  await mkdir(stateDir, { recursive: true })
  return { repo, stateDir }
}

/**
 * The real tool's refusal shape, in one line: the file, the computed span
 * against its budget, and the minimum trim. Standing in for
 * `tools/lint-bead-hygiene.ts` keeps these tests hermetic while pinning the
 * exact contract Yrd owes it — that the diagnostic survives to the author
 * unedited.
 */
const HYGIENE_REFUSAL = "@yrd/core/21000-short.md: span 147 > 135, trim title >=12"
const hygieneGuard = (paths?: readonly string[]) =>
  `guards: [{bead-hygiene: {run: "sh -c 'if git diff --name-only \\"$YRD_BASE_SHA...$YRD_CANDIDATE_SHA\\" | grep -q \\"^@\\"; then echo \\"${HYGIENE_REFUSAL}\\" >&2; exit 1; fi'\"${paths === undefined ? "" : `, paths: [${paths.join(", ")}]`}}}]\n`

function resolvedConfig(source: string): ResolvedYrdProjectConfig {
  const parsed = parseYrdConfig(Bun.YAML.parse(source))
  const entries = parsed.guards.map((guard) => {
    const [name, definition] = Object.entries(guard)[0] ?? []
    if (name === undefined || definition === undefined) throw new Error("fixture guard names nothing")
    return [name, definition] as const
  })
  return {
    base: "main",
    batch: 1,
    steps: ["merge"],
    requires: [],
    definitions: {},
    guards: entries.map(([name]) => name),
    guardDefinitions: Object.fromEntries(entries),
    contest: { concurrency: 1, timeoutMs: 60_000, evaluators: [] },
  }
}

describe("guardScopedPaths — which changed files a guard is about", () => {
  it("selects only the paths a declared glob matches", () => {
    const changed = ["@yrd/core/21000-short.md", "packages/yrd-cli/src/run.ts", "README.md"]
    expect(guardScopedPaths(changed, ["@*/**/*.md"])).toEqual(["@yrd/core/21000-short.md"])
  })

  it("returns nothing when a code-only candidate matches no glob", () => {
    expect(guardScopedPaths(["packages/yrd-cli/src/run.ts"], ["@*/**/*.md"])).toEqual([])
  })

  it("matches at every depth under the scope root, including none", () => {
    // `**` spanning ZERO directories is what makes `@*/**/*.md` — the glob an
    // hh-shaped deployment declares — cover a bead sitting directly in `@yrd/`
    // as well as one nested three deep. If the glob engine ever stopped
    // matching zero, the guard would quietly stop seeing top-level beads and
    // report a clean estate, so the dependency is pinned rather than assumed.
    expect(
      guardScopedPaths(["@yrd/21000-top.md", "@yrd/core/21001-nested.md", "@yrd/a/b/c/21002-deep.md"], ["@*/**/*.md"]),
    ).toEqual(["@yrd/21000-top.md", "@yrd/core/21001-nested.md", "@yrd/a/b/c/21002-deep.md"])
  })

  it("unions multiple globs without duplicating a path two of them match", () => {
    expect(guardScopedPaths(["@yrd/a.md", "docs/b.md"], ["@*/**/*.md", "**/*.md"])).toEqual(["@yrd/a.md", "docs/b.md"])
  })

  it("refuses an empty glob list rather than silently never running the guard", () => {
    // "no declared scope" is the caller's `undefined`. Collapsing it to an empty
    // list here would turn an always-run guard into one that never runs, and the
    // repository would never learn its rule stopped being enforced.
    expect(() => guardScopedPaths(["a.md"], [])).toThrow(/at least one path glob/u)
  })
})

describe("a pre-submit guard refuses in-lane, naming what the author must fix", () => {
  it("surfaces the guard's own file, span and trim verbatim", async () => {
    const { repo, stateDir } = await beadRepository()
    await git(repo, "switch", "-qc", "issue/long-title")
    await writeFile(join(repo, "@yrd", "core", "21001-over-budget.md"), `# ${"x".repeat(120)}\n`)
    await git(repo, "add", "@yrd")
    await git(repo, "commit", "-qm", "add an over-budget bead")

    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard()), {
      PATH: globalThis.process.env.PATH,
    })

    // The whole product of a guard is the diagnostic. Yrd cannot reconstruct
    // the file, the measurement or the repair, so it must not summarize them
    // away into an exit code.
    await expect(guards.run("bead-hygiene")).rejects.toThrow(HYGIENE_REFUSAL)
  })

  it("passes the same content once the title is trimmed", async () => {
    const { repo, stateDir } = await beadRepository()
    await git(repo, "switch", "-qc", "issue/trimmed")
    await writeFile(join(repo, "src.ts"), "export const trimmed = true\n")
    await git(repo, "add", "src.ts")
    await git(repo, "commit", "-qm", "trim the title")

    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard()), {
      PATH: globalThis.process.env.PATH,
    })

    await expect(guards.run("bead-hygiene")).resolves.toMatchObject({
      name: "bead-hygiene",
      status: "passed",
    })
  })

  it("never spawns the guard for a candidate touching no bead files", async () => {
    const { repo, stateDir } = await beadRepository()
    await git(repo, "switch", "-qc", "issue/code-only")
    await writeFile(join(repo, "src.ts"), "export const codeOnly = true\n")
    await git(repo, "add", "src.ts")
    await git(repo, "commit", "-qm", "code only")

    await using runtime = createProcess({ cwd: repo })
    const spawned: string[][] = []
    const process = {
      run(request: ProcessRequest): Promise<ProcessResult> {
        spawned.push([...request.argv])
        return runtime.run(request)
      },
    }
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard(['"@*/**/*.md"'])), {
      PATH: globalThis.process.env.PATH,
    })

    const outcome = await guards.run("bead-hygiene")
    expect(outcome).toMatchObject({ name: "bead-hygiene", status: "skipped" })
    // A skip is reported with the globs that produced it, not passed silently:
    // "looked and found nothing to judge" must be distinguishable from "never ran".
    expect(outcome.reason).toContain("@*/**/*.md")
    // The point of the scope filter is the SPAWN that does not happen. Only git
    // plumbing may run — the guard command itself must be absent.
    expect(spawned.some((argv) => argv.join(" ").includes("grep"))).toBe(false)
    expect(spawned.every((argv) => argv[0] === "git")).toBe(true)
  })

  it("still runs an unscoped guard on a code-only candidate", async () => {
    const { repo, stateDir } = await beadRepository()
    await git(repo, "switch", "-qc", "issue/unscoped")
    await writeFile(join(repo, "src.ts"), "export const unscoped = true\n")
    await git(repo, "add", "src.ts")
    await git(repo, "commit", "-qm", "code only")

    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard()), {
      PATH: globalThis.process.env.PATH,
    })
    // No `paths` means the repository declared no scope, so the guard is the
    // authority on its own relevance and always gets to look.
    await expect(guards.run("bead-hygiene")).resolves.toMatchObject({ status: "passed" })
  })
})

describe("what a guard is told, and what it refuses to guess", () => {
  it("judges an explicit candidate ref without depending on the Bay path", async () => {
    // `pr submit` now hands the durable Bay branch as a ref from the invoking
    // repository. Resolving ambient HEAD instead would guard a different commit
    // than the one being submitted, and would do it silently: both resolve,
    // both look like an answer.
    const { repo, stateDir } = await beadRepository()
    const bay = join(repo, "..", "bay")
    await git(repo, "worktree", "add", "-q", "-b", "issue/in-a-bay", bay)
    await writeFile(join(bay, "@yrd", "core", "21003-in-a-bay.md"), `# ${"z".repeat(120)}\n`)
    await git(bay, "add", "@yrd")
    await git(bay, "commit", "-qm", "an over-budget bead, authored in the bay")
    const bayHead = await git(bay, "rev-parse", "HEAD")
    expect(bayHead).not.toBe(await git(repo, "rev-parse", "HEAD"))

    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard(['"@*/**/*.md"'])), {
      PATH: globalThis.process.env.PATH,
    })

    // The Bay path is deliberately not required: the branch ref is the durable
    // carrier identity and remains resolvable after the workspace is retired.
    await expect(guards.run("bead-hygiene", { cwd: repo, ref: "issue/in-a-bay" })).rejects.toThrow(HYGIENE_REFUSAL)
    await expect(guards.run("bead-hygiene")).resolves.toMatchObject({ status: "skipped" })
  })

  it("names the base and candidate commits in the environment", async () => {
    const { repo, stateDir } = await beadRepository()
    const baseSha = await git(repo, "rev-parse", "main")
    await git(repo, "switch", "-qc", "issue/env")
    await writeFile(join(repo, "src.ts"), "export const env = true\n")
    await git(repo, "add", "src.ts")
    await git(repo, "commit", "-qm", "env")
    const candidateSha = await git(repo, "rev-parse", "HEAD")

    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(
      process,
      stateDir,
      resolvedConfig(
        'guards: [{echo-env: {run: \'printf "%s %s %s" "$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" "$YRD_GUARD"\'}}]\n',
      ),
      { PATH: globalThis.process.env.PATH },
    )

    const outcome = await guards.run("echo-env")
    expect(outcome.stdout).toBe(`${baseSha} ${candidateSha} echo-env`)
    expect(outcome.candidateSha).toBe(candidateSha)
  })

  it("scopes the diff three-dot, so base's own commits are not the author's problem", async () => {
    const { repo, stateDir } = await beadRepository()
    await git(repo, "switch", "-qc", "issue/code-only")
    await writeFile(join(repo, "src.ts"), "export const codeOnly = true\n")
    await git(repo, "add", "src.ts")
    await git(repo, "commit", "-qm", "code only")
    // Base moves on and adds a bead the branch never touched. Two-dot would hand
    // that file to the guard and refuse this author for somebody else's edit.
    await git(repo, "switch", "-q", "main")
    await writeFile(join(repo, "@yrd", "core", "21002-merged-later.md"), `# ${"y".repeat(120)}\n`)
    await git(repo, "add", "@yrd")
    await git(repo, "commit", "-qm", "merge a bead on main")
    await git(repo, "switch", "-q", "issue/code-only")

    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard(['"@*/**/*.md"'])), {
      PATH: globalThis.process.env.PATH,
    })
    await expect(guards.run("bead-hygiene")).resolves.toMatchObject({ status: "skipped" })
  })

  it("refuses an unconfigured guard name instead of quietly passing", async () => {
    const { repo, stateDir } = await beadRepository()
    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(process, stateDir, resolvedConfig(hygieneGuard()), {
      PATH: globalThis.process.env.PATH,
    })
    await expect(guards.run("nonexistent")).rejects.toThrow(/is not configured \(configured: bead-hygiene\)/u)
  })

  it("calls a killed guard infrastructure, never the author's refusal", async () => {
    const { repo, stateDir } = await beadRepository()
    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(
      process,
      stateDir,
      resolvedConfig("guards: [{killed: {run: \"sh -c 'kill -9 $$'\"}}]\n"),
      { PATH: globalThis.process.env.PATH },
    )
    // Reported as a refusal, this would tell the author to fix a carrier that
    // is fine — and no edit they make in response could possibly help.
    await expect(guards.run("killed")).rejects.toThrow(/ended by SIGKILL .* before it produced a verdict/u)
  })

  it("fails loudly when the guard exceeds its declared bound", async () => {
    const { repo, stateDir } = await beadRepository()
    await using process = createProcess({ cwd: repo })
    const guards = configuredGuards(
      process,
      stateDir,
      resolvedConfig('guards: [{slow: {run: "sleep 30", timeoutMs: 250}}]\n'),
      { PATH: globalThis.process.env.PATH },
    )
    await expect(guards.run("slow")).rejects.toThrow(/exceeded 250ms before it produced a verdict/u)
  })
})

describe("the managed pre-submit hook carries the guards", () => {
  it("runs guards ahead of checks, and short-circuits on refusal", async () => {
    const { repo, stateDir } = await beadRepository()
    await using process = createProcess({ cwd: repo })
    const config: ResolvedYrdProjectConfig = {
      ...resolvedConfig(hygieneGuard()),
      checks: ["typecheck"],
      steps: ["typecheck", "merge"],
      definitions: { typecheck: { run: "bun run typecheck", runner: "local" } },
    }
    const checks = configuredChecks(process, stateDir, config, { PATH: globalThis.process.env.PATH })
    const hookPath = await checks.install(repo)
    const hook = await Bun.file(hookPath).text()

    const guardLine = hook.indexOf("yrd guard")
    const checkLine = hook.indexOf("yrd check")
    expect(guardLine).toBeGreaterThan(-1)
    // Order is the feature: a one-spawn verdict must not arrive after a
    // minutes-long one, so the cheap line precedes the expensive one and exits.
    expect(guardLine).toBeLessThan(checkLine)
    expect(hook).toContain("yrd guard || exit $?")
  })

  it("leaves a guardless repository's hook byte-identical, so nothing reinstalls", async () => {
    const { repo, stateDir } = await beadRepository()
    await using process = createProcess({ cwd: repo })
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      checks: ["typecheck"],
      steps: ["typecheck", "merge"],
      requires: [],
      definitions: { typecheck: { run: "bun run typecheck", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
    }
    const checks = configuredChecks(process, stateDir, config, { PATH: globalThis.process.env.PATH })
    const hook = await Bun.file(await checks.install(repo)).text()
    expect(hook).toBe("#!/bin/sh\n# managed-by-yrd: pre-submit-v1\nexec yrd check typecheck\n")
  })
})

describe("guards are repository-declared, and Yrd knows nothing about beads", () => {
  it("accepts a named guard with a command and a path scope", () => {
    const parsed = parseYrdConfig(
      Bun.YAML.parse('guards: [{bead-hygiene: {run: "bun tools/lint-bead-hygiene.ts", paths: ["@*/**/*.md"]}}]\n'),
    )
    expect(parsed.guards).toEqual([
      { "bead-hygiene": { run: "bun tools/lint-bead-hygiene.ts", paths: ["@*/**/*.md"] } },
    ])
  })

  it("accepts the string shorthand for an unscoped guard", () => {
    expect(parseYrdConfig(Bun.YAML.parse('guards: [{lint: "bun run lint"}]\n')).guards).toEqual([
      { lint: { run: "bun run lint" } },
    ])
  })

  it("defaults to no guards, so an existing repository is unaffected", () => {
    expect(parseYrdConfig(Bun.YAML.parse("checks: [typecheck]\n")).guards).toEqual([])
  })

  it("refuses a duplicate guard name", () => {
    expect(() => parseYrdConfig(Bun.YAML.parse('guards: [{lint: "a"}, {lint: "b"}]\n'))).toThrow(/duplicate guards/u)
  })

  it("refuses a guard with no command", () => {
    expect(() => parseYrdConfig(Bun.YAML.parse('guards: [{lint: {paths: ["*.md"]}}]\n'))).toThrow(/config/u)
  })

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() => parseYrdConfig(Bun.YAML.parse('guards: [{lint: {run: "a", mode: strict}}]\n'))).toThrow(/config/u)
  })
})
