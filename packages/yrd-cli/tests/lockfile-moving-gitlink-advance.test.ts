/**
 * @failure Nobody had run a real lockfile-moving gitlink advance through both enforcement
 *          points at once. Four typed refusals on one live specimen (this package at
 *          `fe5a7058`, silvery ^0.23.2 -> ^0.24.0) and two terminal `manifest-co-change` refusals
 *          (yrdpin#294, yrdpin#296, both 2026-08-15) were the only evidence either way; the
 *          2026-08-18 narrow `samePaths`-widening design was ratified from code reading, not
 *          from a live merge. This is that measurement, pinned as a regression test.
 * @level l1
 * @consumer @i/10-yrd/lockfile-moving-gitlink-advance-merges
 *
 * END TO END, deliberately: this drives the REAL shaset-commit writer
 * (`synthesizeGitlinkWrapper`) with the REAL production pin-intent provisioner
 * (`createPinIntentProvisioner` -> real `submoduleManifestDrift` -> real
 * `ensureWorkspaceDependencies`, which runs a REAL `bun install` against the real npm
 * registry), over a real git superproject/submodule pair. The only stand-in is
 * `materializeSubmodules` — production resolves that through git-super's worktree store,
 * which this fixture does not construct; the fixture checks out the submodule's working
 * tree to the candidate pin directly instead, which is the one property real
 * materialization guarantees before provisioning runs.
 *
 * `evaluateLockfileConsistency` in the independent `manifest-co-change` gate
 * (`tools/lockfile-consistency.ts`, hh-root, outside this vendored package) is NOT
 * imported here — yrd is vendored standalone and a test inside it must not depend on the
 * superproject that happens to vendor it today. `declaredLockDependencies` below is a
 * narrow, cited mirror of that function's oracle (same trailing-comma strip, same
 * `workspaces[member].dependencies` shape — verified byte-for-byte against a real `bun.lock`
 * before this file was written). The negative control at the end of the test keeps that
 * mirror honest: it proves the comparison would have FAILED on the pre-regeneration lock,
 * so the positive assertion is not vacuously true.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ProcessRequest, ProcessResult } from "@yrd/process"
import { synthesizeGitlinkWrapper } from "../../yrd-queue/src/command.ts"
import { createPinIntentProvisioner } from "../src/host.ts"

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

async function bun(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** The same minimal real-git adapter `gitlink-wrapper.test.ts` uses, satisfying both
 * `synthesizeGitlinkWrapper`'s `Pick<Git, "run" | "commitTree" | "process" | "env">` and
 * `createPinIntentProvisioner`'s `Pick<Process, "run">` from the one `.process`. */
function gitAdapter() {
  const env = Object.fromEntries(
    Object.entries(globalThis.process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    env,
    process: {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.stdin !== undefined) throw new Error("fixture does not accept process stdin")
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

/**
 * A superproject recording one submodule, whose own package.json bumps a real, small,
 * two-published-version registry dependency (`is-odd` 3.0.0 -> 3.0.1) between base and
 * next — the exact shape that forces the root `bun.lock` to move when the pin advances,
 * per `submoduleManifestDrift`'s own contract (a moved dependency spec inside a tracked
 * `package.json` reachable from the submodule root). Chosen only for being tiny and
 * real; nothing about the fixture depends on which package it is.
 */
async function lockfileMovingSubmoduleFixture(): Promise<{ repo: string; parent: string; base: string; next: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-lockfile-moving-gitlink-"))
  roots.push(root)
  const source = join(root, "source")
  const repo = join(root, "product")

  await mkdir(source)
  await sh(source, ["init", "-q", "-b", "main"])
  await writeFile(
    join(source, "package.json"),
    `${JSON.stringify({ name: "dep", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } }, undefined, 2)}\n`,
  )
  await sh(source, ["add", "package.json"])
  await sh(source, ["commit", "-qm", "submodule base"])
  const base = (await sh(source, ["rev-parse", "HEAD"])).stdout

  await mkdir(repo)
  await sh(repo, ["init", "-q", "-b", "main"])
  await writeFile(join(repo, ".gitignore"), "node_modules/\n")
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "product", private: true, workspaces: ["dep"] }, undefined, 2)}\n`,
  )
  await sh(repo, ["add", ".gitignore", "package.json"])
  await sh(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "dep"])

  const install = await bun(repo, ["install", "--ignore-scripts"])
  if (install.code !== 0) throw new Error(`fixture base install failed: ${install.stderr || install.stdout}`)

  await sh(repo, ["add", "-A"])
  await sh(repo, ["commit", "-qm", "base"])
  const parent = (await sh(repo, ["rev-parse", "HEAD"])).stdout

  await writeFile(
    join(source, "package.json"),
    `${JSON.stringify({ name: "dep", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } }, undefined, 2)}\n`,
  )
  await sh(source, ["commit", "-qam", "submodule next - moves a dependency spec"])
  const next = (await sh(source, ["rev-parse", "HEAD"])).stdout
  await sh(join(repo, "dep"), ["fetch", "-q", "origin", next])

  return { repo, parent, base, next }
}

/**
 * Mirrors `tools/lockfile-consistency.ts`'s `parseLockfileWorkspaces` + `toDeclared`
 * dependency extraction (same trailing-comma strip, same `workspaces[member].dependencies`
 * shape) — the exact oracle the independent `manifest-co-change` gate applies. Not an
 * import of that function: see this file's header for why. Kept honest by the negative
 * control in the test below.
 */
function declaredLockDependencies(lockText: string, member: string): Record<string, string> {
  const parsed = JSON.parse(lockText.replace(/,(\s*[}\]])/gu, "$1")) as {
    workspaces?: Record<string, { dependencies?: Record<string, string> }>
  }
  return parsed.workspaces?.[member]?.dependencies ?? {}
}

describe("a lockfile-moving gitlink advance — checks-before-queueing end to end", () => {
  it("the shaset-commit writer's regenerated bun.lock agrees with the independent lockfile-consistency oracle", async () => {
    const fixture = await lockfileMovingSubmoduleFixture()
    const { repo, parent, next } = fixture
    const adapter = gitAdapter()
    const artifactRoot = await mkdtemp(join(tmpdir(), "yrd-lockfile-moving-artifacts-"))
    roots.push(artifactRoot)

    const provisionPinIntent = createPinIntentProvisioner({
      process: adapter.process,
      repo,
      artifactRoot,
      // Stands in for git-super's worktree materializer (see file header): checks the
      // submodule's working tree out to the candidate pin directly.
      materializeSubmodules: async () => {
        await sh(join(repo, "dep"), ["checkout", "-q", next])
      },
    })

    const result = await synthesizeGitlinkWrapper(
      adapter,
      repo,
      parent,
      [{ path: "dep", sha: next }],
      "advance dep pin",
      provisionPinIntent,
    )

    // ROW 1 OF THE BEAD: does it merge, or does the lockfile-coherence guard refuse it?
    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    expect(result.output.generatedPaths).toEqual(["bun.lock"])
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n").toSorted()).toEqual(["bun.lock", "dep"])
    const gitlinkEntry = await sh(repo, ["ls-tree", result.output.commit, "--", "dep"])
    expect(gitlinkEntry.stdout).toContain(`160000 commit ${next}`)

    // BEAD ACCEPTANCE ROW 3: the lockfile delta is disclosed as a run artifact naming the
    // manifests, the authorizing refusal, and the before/after lockfile identity.
    const disclosureDir = join(artifactRoot, "lockfile-regeneration")
    const disclosureFiles = await readdir(disclosureDir)
    expect(disclosureFiles).toHaveLength(1)
    const disclosureFile = disclosureFiles[0]
    if (disclosureFile === undefined) throw new Error("unreachable")
    const disclosure = JSON.parse(await readFile(join(disclosureDir, disclosureFile), "utf8")) as {
      lockfile: string
      changedSubmoduleManifests: readonly string[]
      frozenRefusal: string
      lockfileChanged: boolean
      before: { sha256: string }
      after: { sha256: string }
    }
    expect(disclosure.lockfile).toBe("bun.lock")
    expect(disclosure.changedSubmoduleManifests).toEqual(["dep/package.json"])
    expect(disclosure.frozenRefusal).toContain("lockfile had changes, but lockfile is frozen")
    expect(disclosure.lockfileChanged).toBe(true)
    expect(disclosure.before.sha256).not.toBe(disclosure.after.sha256)

    // Does the INDEPENDENT gate's oracle agree with what the wrapper just produced?
    const candidateLock = await sh(repo, ["show", `${result.output.commit}:bun.lock`])
    const candidateDepManifest = await sh(join(repo, "dep"), ["show", `${next}:package.json`])
    const declaredInLock = declaredLockDependencies(candidateLock.stdout, "dep")
    const declaredInManifest =
      (JSON.parse(candidateDepManifest.stdout) as { dependencies?: Record<string, string> }).dependencies ?? {}
    expect(declaredInLock).toEqual(declaredInManifest)
    expect(declaredInLock["is-odd"]).toBe("3.0.1")

    // NEGATIVE CONTROL: the pre-regeneration lock at `parent` still names the OLD
    // version, so the equality above is not vacuous — the mirror oracle has teeth.
    const baseLock = await sh(repo, ["show", `${parent}:bun.lock`])
    const declaredInBaseLock = declaredLockDependencies(baseLock.stdout, "dep")
    expect(declaredInBaseLock).not.toEqual(declaredInManifest)
    expect(declaredInBaseLock["is-odd"]).toBe("3.0.0")
  }, 60_000)
})
