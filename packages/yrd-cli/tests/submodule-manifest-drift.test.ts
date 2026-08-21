/**
 * @failure A submodule pin advance that changes the submodule's dependency specs is invisible, so the
 *          superproject's frozen lockfile refuses a candidate that can never be cured ahead of time.
 * @level l3
 * @consumer @yrd/cli candidate provisioning
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { submoduleManifestDrift } from "../src/submodule-manifest-drift.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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

async function identify(repo: string): Promise<void> {
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
}

function manifest(silvery: string): string {
  return `${JSON.stringify({ name: "dep", private: true, dependencies: { silvery } }, undefined, 2)}\n`
}

function manifestWithExports(silvery: string): string {
  return `${JSON.stringify(
    {
      name: "dep",
      private: true,
      dependencies: { silvery },
      exports: { ".": "./src/index.ts", "./self-mailbox-authority": "./src/self-mailbox-authority.ts" },
      files: ["src"],
    },
    undefined,
    2,
  )}\n`
}

/**
 * A superproject pinning one submodule, plus two candidate advances of that pin:
 * one that moves the submodule's dependency specs and one that does not. This is
 * the shape of the real deadlock — vendor/yrd advancing silvery ^0.23.2 → ^0.24.0
 * under an hh root whose bun.lock resolves the old spec.
 */
async function pinnedSuperproject(): Promise<{
  repo: string
  baseSha: string
  specChangeSha: string
  metadataChangeSha: string
  unrelatedChangeSha: string
  deletionSha: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-manifest-drift-"))
  roots.push(root)
  const repo = join(root, "super")
  const module = join(root, "dep")

  await git(root, "init", "-q", "-b", "main", module)
  await identify(module)
  await writeFile(join(module, "package.json"), manifest("^0.23.2"))
  await git(module, "add", "package.json")
  await git(module, "commit", "-qm", "dep at 0.23.2")

  await git(root, "init", "-q", "-b", "main", repo)
  await identify(repo)
  await git(repo, "config", "protocol.file.allow", "always")
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "super", private: true })}\n`)
  await git(repo, "add", "package.json")
  await git(repo, "commit", "-qm", "superproject")
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep")
  await git(repo, "add", ".gitmodules", "dep")
  await git(repo, "commit", "-qm", "pin dep")
  const baseSha = await git(repo, "rev-parse", "HEAD")

  // Both advances branch from the SAME base pin, so they differ from the base in
  // exactly one respect each — otherwise the docs-only pin would inherit the spec
  // change and the two cases would stop being distinguishable.
  await git(module, "switch", "-qc", "spec")
  await writeFile(join(module, "package.json"), manifest("^0.24.0"))
  await git(module, "add", "package.json")
  await git(module, "commit", "-qm", "accept silvery 0.24.0")
  const specPin = await git(module, "rev-parse", "HEAD")

  await git(module, "switch", "-q", "main")
  await git(module, "switch", "-qc", "docs")
  await writeFile(join(module, "README.md"), "docs only\n")
  await git(module, "add", "README.md")
  await git(module, "commit", "-qm", "docs only")
  const unrelatedPin = await git(module, "rev-parse", "HEAD")

  await git(module, "switch", "-q", "main")
  await git(module, "switch", "-qc", "metadata")
  await writeFile(join(module, "package.json"), manifestWithExports("^0.23.2"))
  await git(module, "add", "package.json")
  await git(module, "commit", "-qm", "export mailbox authority")
  const metadataPin = await git(module, "rev-parse", "HEAD")

  await git(join(repo, "dep"), "fetch", "-q", "origin")
  await git(join(repo, "dep"), "checkout", "-q", specPin)
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "advance dep to spec change")
  const specChangeSha = await git(repo, "rev-parse", "HEAD")

  await git(repo, "reset", "-q", "--soft", baseSha)
  await git(join(repo, "dep"), "checkout", "-q", unrelatedPin)
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "advance dep to docs only")
  const unrelatedChangeSha = await git(repo, "rev-parse", "HEAD")

  await git(repo, "reset", "-q", "--soft", baseSha)
  await git(join(repo, "dep"), "checkout", "-q", metadataPin)
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "advance dep to metadata change")
  const metadataChangeSha = await git(repo, "rev-parse", "HEAD")

  await git(repo, "reset", "-q", "--soft", baseSha)
  await git(repo, "rm", "-q", "--cached", "dep")
  await writeFile(join(repo, ".gitmodules"), "")
  await git(repo, "add", ".gitmodules")
  await git(repo, "commit", "-qm", "delete dep from the component model")
  const deletionSha = await git(repo, "rev-parse", "HEAD")

  return { repo, baseSha, specChangeSha, metadataChangeSha, unrelatedChangeSha, deletionSha }
}

function refuse(message: string): never {
  throw new Error(message)
}

describe("submoduleManifestDrift", () => {
  it("names the manifest a pin advance moved, so provisioning can authorize a regeneration", async () => {
    const { repo, baseSha, specChangeSha } = await pinnedSuperproject()
    await using process = createProcess({ cwd: repo })

    const drifts = await submoduleManifestDrift(process, {
      repo,
      workspace: repo,
      baseSha,
      candidateSha: specChangeSha,
      fail: refuse,
    })

    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ submodule: "dep", manifests: ["dep/package.json"] })
    expect(drifts[0]?.basePin).not.toBe(drifts[0]?.candidatePin)
  })

  // @failure A submodule DELETION set the candidate gitlink to the null pin, and the
  //          materialization guard read that as an unreadable pin and refused. The
  //          deletion path was therefore unimplementable: authorized, no-data-loss
  //          proven, and still unable to pass its own checks. Measured on hh-web 2026-08-21.
  it("passes a component DELETION, whose candidate side has no manifests to compare", async () => {
    const { repo, baseSha, deletionSha } = await pinnedSuperproject()
    await using process = createProcess({ cwd: repo })

    // The component is leaving, so its manifests cannot drift against anything.
    expect(
      await submoduleManifestDrift(process, {
        repo,
        workspace: repo,
        baseSha,
        candidateSha: deletionSha,
        fail: refuse,
      }),
    ).toEqual([])
  })

  it("STILL refuses loudly when a non-deleted submodule is not materialized", async () => {
    const { repo, baseSha, specChangeSha } = await pinnedSuperproject()
    await using process = createProcess({ cwd: repo })
    // Discriminating on the null pin must not become "skip whenever the workdir is
    // missing" — that would hide a broken checkout, which the docblock forbids.
    await rm(join(repo, "dep", ".git"), { recursive: true, force: true })

    await expect(
      submoduleManifestDrift(process, {
        repo,
        workspace: repo,
        baseSha,
        candidateSha: specChangeSha,
        fail: refuse,
      }),
    ).rejects.toThrow(/is not materialized/u)
  })

  it("withholds authorization when the pin moved but no manifest did", async () => {
    const { repo, baseSha, unrelatedChangeSha } = await pinnedSuperproject()
    await using process = createProcess({ cwd: repo })

    // A pin advance is NOT by itself a reason to relax --frozen-lockfile. Only a
    // moved manifest can make the superproject's lockfile uncurable ahead of time.
    expect(
      await submoduleManifestDrift(process, {
        repo,
        workspace: repo,
        baseSha,
        candidateSha: unrelatedChangeSha,
        fail: refuse,
      }),
    ).toEqual([])
  })

  it("withholds authorization when a manifest changed outside its dependency specs", async () => {
    const { repo, baseSha, metadataChangeSha } = await pinnedSuperproject()
    await using process = createProcess({ cwd: repo })

    expect(
      await submoduleManifestDrift(process, {
        repo,
        workspace: repo,
        baseSha,
        candidateSha: metadataChangeSha,
        fail: refuse,
      }),
    ).toEqual([])
  })

  it("reports no drift between a commit and itself", async () => {
    const { repo, baseSha } = await pinnedSuperproject()
    await using process = createProcess({ cwd: repo })

    expect(
      await submoduleManifestDrift(process, { repo, workspace: repo, baseSha, candidateSha: baseSha, fail: refuse }),
    ).toEqual([])
  })

  it("refuses loudly when the submodule is not materialized, rather than assuming drift", async () => {
    const { repo, baseSha, specChangeSha } = await pinnedSuperproject()
    const bare = await mkdtemp(join(tmpdir(), "yrd-manifest-drift-empty-"))
    roots.push(bare)
    await using process = createProcess({ cwd: repo })

    // Unknown must never resolve to "authorized": the whole point of the guard is
    // that an ordinary uncommitted lockfile keeps refusing.
    await expect(
      submoduleManifestDrift(process, {
        repo,
        workspace: bare,
        baseSha,
        candidateSha: specChangeSha,
        fail: refuse,
      }),
    ).rejects.toThrow(/submodule 'dep' is not materialized/u)
  })
})
