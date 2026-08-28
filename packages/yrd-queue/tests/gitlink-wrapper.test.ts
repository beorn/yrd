/**
 * @failure The shaset-commit writer's contract changes without a test saying so — the wrapper
 *          had ZERO behavioural coverage while being "the ONE generated-root implementation
 *          shared by composed PRs, pin intents, and the materialize escape hatch".
 * @level l1
 * @consumer @i/10-merge-queue/b-derivation-sites — step (b)'s entry seam
 *
 * CHARACTERIZATION, not specification — the (a) pattern applied to (b)'s seam. Every
 * assertion pins what `synthesizeGitlinkWrapper` does TODAY, so changes to this file merge
 * DELIBERATELY, in the same commit as the mechanism. The (b) provisioner lift flipped the
 * one marked case here: the single-update provisioner refusal became multi-update support,
 * and the provisioner now runs for every gitlink-bearing wrapper call.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ProcessRequest, ProcessResult } from "@yrd/process"
import { synthesizeGitlinkWrapper } from "../src/command.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function sh(repo: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Yrd Test",
      GIT_AUTHOR_EMAIL: "yrd@example.invalid",
      GIT_COMMITTER_NAME: "Yrd Test",
      GIT_COMMITTER_EMAIL: "yrd@example.invalid",
    },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** The two members the wrapper actually uses, over a real repository. */
function gitAdapter() {
  const env = Object.fromEntries(
    Object.entries(globalThis.process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    env,
    process: {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.stdin !== undefined) throw new Error("gitlink wrapper fixture does not accept process stdin")
        const started = performance.now()
        const child = Bun.spawn([...request.argv], {
          cwd: request.cwd,
          env: { ...globalThis.process.env, ...request.env },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return {
          exitCode,
          stdout,
          stderr,
          durationMs: performance.now() - started,
          signal: null,
          timedOut: false,
          verdict: "EXITED",
        }
      },
    },
    async run(repo: string, args: readonly string[], _allowFailure?: boolean) {
      const result = await sh(repo, args)
      // The full GitResult shape: vitest does not typecheck, and the (a) fixture
      // already paid for an under-filled return type once — tsc is the gate here.
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 0,
        signal: null,
        timedOut: false,
      }
    },
    async commitTree(repo: string, tree: string, parents: readonly string[], message: string): Promise<string> {
      const result = await sh(repo, [
        "commit-tree",
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-m",
        message,
      ])
      if (result.code !== 0) throw new Error(result.stderr || "commit-tree failed")
      return result.stdout
    },
  }
}

type GitlinkPin = Readonly<{ base: string; next: string }>
type GitlinkFixture = Readonly<{ repo: string; parent: string; pins: ReadonlyMap<string, GitlinkPin> }>

function pin(fixture: GitlinkFixture, path: string): GitlinkPin {
  const value = fixture.pins.get(path)
  if (value === undefined) throw new Error(`missing fixture pin for ${path}`)
  return value
}

/**
 * The base commit already RECORDS every gitlink the wrapper will move. Discovered by
 * characterization: `update-index --cacheinfo <mode>,<sha>,<path>` (the comma form the
 * wrapper uses) refuses to ADD a path that is not in the index — "missing --add option?",
 * exit 128 — so the wrapper's contract is UPDATE-only. That matches production, where
 * added and deleted gitlinks are refused before composition ever runs.
 */
async function repository(paths: readonly string[] = ["dep"]): Promise<GitlinkFixture> {
  const root = await mkdtemp(join(tmpdir(), "yrd-gitlink-wrapper-"))
  roots.push(root)
  const repo = join(root, "product")
  await mkdir(repo)
  await sh(repo, ["init", "-q", "-b", "main"])
  await writeFile(join(repo, "README.md"), "base\n")
  await sh(repo, ["add", "README.md"])
  const sources = new Map<string, string>()
  const bases = new Map<string, string>()
  for (const path of paths) {
    const source = join(root, `source-${path.replaceAll("/", "-")}`)
    await mkdir(source)
    await sh(source, ["init", "-q", "-b", "main"])
    await writeFile(join(source, "value.txt"), "base\n")
    await sh(source, ["add", "value.txt"])
    await sh(source, ["commit", "-qm", "base"])
    sources.set(path, source)
    bases.set(path, (await sh(source, ["rev-parse", "HEAD"])).stdout)
    await sh(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, path])
  }
  await sh(repo, ["commit", "-qm", "base"])
  const parent = (await sh(repo, ["rev-parse", "HEAD"])).stdout
  const pins = new Map<string, GitlinkPin>()
  for (const path of paths) {
    const source = sources.get(path)
    const base = bases.get(path)
    if (source === undefined || base === undefined) throw new Error(`incomplete fixture source for ${path}`)
    await writeFile(join(source, "value.txt"), `next ${path}\n`)
    await sh(source, ["add", "value.txt"])
    await sh(source, ["commit", "-qm", "next"])
    const next = (await sh(source, ["rev-parse", "HEAD"])).stdout
    await sh(join(repo, path), ["fetch", "-q", "origin", next])
    pins.set(path, { base, next })
  }
  return { repo, parent, pins }
}

describe("synthesizeGitlinkWrapper — the shaset-commit writer's contract as of the (b) build's start", () => {
  it("writes a commit whose diff is exactly the gitlink updates, nothing else", async () => {
    const fixture = await repository()
    const { repo, parent } = fixture
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [{ path: "dep", sha: pin(fixture, "dep").next }],
      "wrapper",
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n")).toEqual(["dep"])
    const entry = await sh(repo, ["ls-tree", result.output.commit, "--", "dep"])
    expect(entry.stdout).toContain(`160000 commit ${pin(fixture, "dep").next}`)
  })

  it("with a provisioner, one gitlink plus exactly bun.lock is the whole diff", async () => {
    const fixture = await repository()
    const { repo, parent } = fixture
    const provisioned: string[] = []
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [{ path: "dep", sha: pin(fixture, "dep").next }],
      "wrapper",
      async ({ provisionalCandidateSha }) => {
        provisioned.push(provisionalCandidateSha)
        await writeFile(join(repo, "bun.lock"), "regenerated\n")
        return { generatedPaths: ["bun.lock"] }
      },
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    // The provisioner saw a real provisional commit, not the parent.
    expect(provisioned).toHaveLength(1)
    expect(provisioned[0]).not.toBe(parent)
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n").toSorted()).toEqual(["bun.lock", "dep"])
  })

  /**
   * FLIPPED by the (b) provisioner lift, in the same commit as the mechanism, as this
   * file's header requires. The refusal this case used to pin ("expected one gitlink
   * update") was the pin-intent leg's guard, and it left composed multi-submodule
   * candidates with NO lock regeneration. The lifted contract: the provisioner runs
   * ONCE over the whole update set, and one shaset commit carries every gitlink update
   * plus the regenerated bun.lock.
   */
  it("fills in bun.lock across more than one gitlink update in one shaset commit", async () => {
    const fixture = await repository(["dep-a", "dep-b"])
    const { repo, parent } = fixture
    const provisioned: string[] = []
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [
        { path: "dep-a", sha: pin(fixture, "dep-a").next },
        { path: "dep-b", sha: pin(fixture, "dep-b").next },
      ],
      "wrapper",
      async ({ provisionalCandidateSha }) => {
        provisioned.push(provisionalCandidateSha)
        await writeFile(join(repo, "bun.lock"), "regenerated\n")
        return { generatedPaths: ["bun.lock"] }
      },
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    // One provisioner run over the whole update set — one shaset commit, one lock write.
    expect(provisioned).toHaveLength(1)
    expect(result.output.generatedPaths).toEqual(["bun.lock"])
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n").toSorted()).toEqual(["bun.lock", "dep-a", "dep-b"])
    const entryA = await sh(repo, ["ls-tree", result.output.commit, "--", "dep-a"])
    expect(entryA.stdout).toContain(`160000 commit ${pin(fixture, "dep-a").next}`)
    const entryB = await sh(repo, ["ls-tree", result.output.commit, "--", "dep-b"])
    expect(entryB.stdout).toContain(`160000 commit ${pin(fixture, "dep-b").next}`)
  })

  it("stages a drift-free multi-gitlink update as a gitlinks-only shaset commit", async () => {
    const fixture = await repository(["dep-a", "dep-b"])
    const { repo, parent } = fixture
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [
        { path: "dep-a", sha: pin(fixture, "dep-a").next },
        { path: "dep-b", sha: pin(fixture, "dep-b").next },
      ],
      "wrapper",
      // No manifest moved dependency specs across the staged range, so the
      // provisioner generates nothing and the shaset commit is gitlinks only.
      async () => ({ generatedPaths: [] }),
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    expect(result.output.generatedPaths).toEqual([])
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n").toSorted()).toEqual(["dep-a", "dep-b"])
  })

  it("refuses a provisioner that generates anything but bun.lock", async () => {
    const fixture = await repository()
    const { repo, parent } = fixture
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [{ path: "dep", sha: pin(fixture, "dep").next }],
      "wrapper",
      async () => {
        await writeFile(join(repo, "package.json"), "{}\n")
        return { generatedPaths: ["package.json"] }
      },
    )

    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.error.code).toBe("wrapper-mismatch")
    expect(result.error.message).toContain("allowed [bun.lock]")
  })

  /**
   * The live PR2164 shape (2026-08-28): the content merge already brought the submodule
   * to the value the shaset fill computed, so `update-index` had nothing to write and the
   * staged set came back empty against `expected [km]`. The wrapper wrote a refusal out of
   * a no-op and parked the change for five hours.
   */
  it("treats a gitlink the parent already carries as satisfied, not as a missing path", async () => {
    const fixture = await repository()
    const { repo, parent } = fixture
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      // The base already RECORDS this exact value — asking for it stages nothing.
      [{ path: "dep", sha: pin(fixture, "dep").base }],
      "wrapper",
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    expect(result.output.commit).toBe(parent)
    expect(result.output.generatedPaths).toEqual([])
  })

  it("writes only the gitlinks that still move when another is already at its value", async () => {
    const fixture = await repository(["dep-a", "dep-b"])
    const { repo, parent } = fixture
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [
        { path: "dep-a", sha: pin(fixture, "dep-a").base },
        { path: "dep-b", sha: pin(fixture, "dep-b").next },
      ],
      "wrapper",
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n")).toEqual(["dep-b"])
    const entryA = await sh(repo, ["ls-tree", result.output.commit, "--", "dep-a"])
    expect(entryA.stdout).toContain(`160000 commit ${pin(fixture, "dep-a").base}`)
  })

  /**
   * The half of the samePaths proof that still carries information: a path nobody asked
   * for reaching the shaset tree is a real integrity failure, and relaxing the no-op leg
   * above must not relax this one.
   */
  it("still refuses when a path nobody requested reaches the staged set", async () => {
    const fixture = await repository()
    const { repo, parent } = fixture
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [{ path: "dep", sha: pin(fixture, "dep").next }],
      "wrapper",
      async () => {
        await writeFile(join(repo, "stowaway.txt"), "unrequested\n")
        await sh(repo, ["add", "--", "stowaway.txt"])
        return { generatedPaths: [] }
      },
    )

    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.error.code).toBe("wrapper-mismatch")
    expect(result.error.message).toContain("stowaway.txt")
  })

  it("returns the parent untouched when there is nothing to stage — the nothing-new shape", async () => {
    const { repo, parent } = await repository()
    const result = await synthesizeGitlinkWrapper(gitAdapter(), repo, parent, [], "wrapper")

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    expect(result.output.commit).toBe(parent)
  })
})
