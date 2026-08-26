/**
 * @failure A failed repository postinstall leaves node_modules behind, so a later Bay attempt skips provisioning.
 * @level l3
 * @consumer @yrd/cli workspace provisioning
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"
import { ensureWorkspaceDependencies, type LockfileRegenerationEvidence } from "../src/workspace-provisioning.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function result(exitCode: number, stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, durationMs: 1, timedOut: false }
}

/** Bun 1.3.14's verbatim refusal, captured from a real frozen install against a
 * manifest whose spec moved under it. Matching anything looser would let a cold
 * cache or a dead registry masquerade as a stale lockfile. */
const FROZEN_REFUSAL =
  "error: lockfile had changes, but lockfile is frozen\n" +
  "note: try re-running without --frozen-lockfile and commit the updated lockfile"

const FROZEN = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]
const RELAXED = ["bun", "install", "--ignore-scripts"]

async function lockedWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-provision-lockfile-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "candidate", private: true, dependencies: { silvery: "^0.24.0" } })}\n`,
  )
  await writeFile(join(root, "bun.lock"), '{"silvery":"0.23.2"}\n')
  return root
}

describe("ensureWorkspaceDependencies", () => {
  it("does not treat node_modules from a failed postinstall as provisioned (22600)", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-provision-transaction-"))
    roots.push(root)
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({
        name: "provision-transaction-fixture",
        private: true,
        dependencies: { fixture: "1.0.0" },
        scripts: { postinstall: "fixture-verify" },
      })}\n`,
    )
    await writeFile(join(root, "bun.lock"), "{}\n")

    const requests: ProcessRequest[] = []
    const process = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        requests.push(request)
        if (request.argv[1] === "install") {
          await mkdir(join(root, "node_modules"), { recursive: true })
          return result(0)
        }
        return result(1, "fixture postinstall refused")
      },
    } satisfies Pick<Process, "run">
    const provision = () =>
      ensureWorkspaceDependencies(process, {
        path: root,
        subject: "fixture workspace",
        runPostinstall: true,
        fail(message): never {
          throw new Error(message)
        },
      })

    await expect(provision()).rejects.toThrow("fixture postinstall refused")
    await expect(provision()).rejects.toThrow("fixture postinstall refused")
    expect(requests.map((request) => request.argv)).toEqual([
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["bun", "run", "postinstall"],
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["bun", "run", "postinstall"],
    ])
  })

  // A submodule pin advance that moves that submodule's dependency specs makes
  // the superproject lockfile stale the instant it merges, and gitlinks merge
  // alone — so the cure can ride neither before nor with the advance, and
  // --frozen-lockfile deadlocks the intent forever (runs R2303/05/06/08).
  describe("stale lockfile caused by a submodule pin advance", () => {
    it("regenerates the lockfile and discloses the delta as evidence", async () => {
      const root = await lockedWorkspace()
      const argvs: string[][] = []
      const regenerated: LockfileRegenerationEvidence[] = []
      const process = {
        async run(request: ProcessRequest): Promise<ProcessResult> {
          argvs.push([...request.argv])
          if (request.argv.includes("--frozen-lockfile")) return result(1, FROZEN_REFUSAL)
          await writeFile(join(root, "bun.lock"), '{"silvery":"0.24.0"}\n')
          await mkdir(join(root, "node_modules"), { recursive: true })
          return result(0)
        },
      } satisfies Pick<Process, "run">

      await ensureWorkspaceDependencies(process, {
        path: root,
        subject: "candidate workspace",
        lockfileRegeneration: {
          changedSubmoduleManifests: () => Promise.resolve(["vendor/yrd/package.json"]),
          record(evidence) {
            regenerated.push(evidence)
          },
        },
        fail(message): never {
          throw new Error(message)
        },
      })

      expect(argvs).toEqual([FROZEN, RELAXED])
      expect(regenerated).toHaveLength(1)
      expect(regenerated[0]).toMatchObject({
        path: root,
        manager: "bun",
        lockfile: "bun.lock",
        changedSubmoduleManifests: ["vendor/yrd/package.json"],
        lockfileChanged: true,
      })
      // The disclosure has to name WHICH manifests forced it, or a reader cannot
      // tell a legitimate pin advance from a lockfile someone forgot to commit.
      expect(regenerated[0]?.frozenRefusal).toContain("lockfile is frozen")
      expect(regenerated[0]?.before.sha256).not.toBe(regenerated[0]?.after.sha256)
    })

    it("keeps frozen absolute when no changed submodule manifest explains the staleness", async () => {
      const root = await lockedWorkspace()
      const argvs: string[][] = []
      const process = {
        run(request: ProcessRequest): Promise<ProcessResult> {
          argvs.push([...request.argv])
          return Promise.resolve(result(1, FROZEN_REFUSAL))
        },
      } satisfies Pick<Process, "run">

      await expect(
        ensureWorkspaceDependencies(process, {
          path: root,
          subject: "candidate workspace",
          lockfileRegeneration: {
            changedSubmoduleManifests: () => Promise.resolve([]),
            record() {
              throw new Error("must not record a regeneration that never happened")
            },
          },
          fail(message): never {
            throw new Error(message)
          },
        }),
      ).rejects.toThrow(/no changed submodule manifest explains it/u)

      // Never a second install: an uncommitted lockfile must keep refusing.
      expect(argvs).toEqual([FROZEN])
    })

    it("never relaxes a failure that is not a stale-lockfile refusal", async () => {
      const root = await lockedWorkspace()
      const argvs: string[][] = []
      let authorizationConsulted = false
      const process = {
        run(request: ProcessRequest): Promise<ProcessResult> {
          argvs.push([...request.argv])
          return Promise.resolve(result(7, "dependency cache unavailable"))
        },
      } satisfies Pick<Process, "run">

      await expect(
        ensureWorkspaceDependencies(process, {
          path: root,
          subject: "candidate workspace",
          lockfileRegeneration: {
            changedSubmoduleManifests() {
              authorizationConsulted = true
              return Promise.resolve(["vendor/yrd/package.json"])
            },
            record() {
              throw new Error("must not record a regeneration for a cold cache")
            },
          },
          fail(message): never {
            throw new Error(message)
          },
        }),
      ).rejects.toThrow("dependency cache unavailable")

      expect(argvs).toEqual([FROZEN])
      // A cold cache is not a lockfile question, so the guard is never even asked.
      expect(authorizationConsulted).toBe(false)
    })

    it("fails loudly naming both attempts when the regeneration also fails", async () => {
      const root = await lockedWorkspace()
      const process = {
        run(request: ProcessRequest): Promise<ProcessResult> {
          return Promise.resolve(
            request.argv.includes("--frozen-lockfile") ? result(1, FROZEN_REFUSAL) : result(1, "registry unreachable"),
          )
        },
      } satisfies Pick<Process, "run">

      const failure = await ensureWorkspaceDependencies(process, {
        path: root,
        subject: "candidate workspace",
        lockfileRegeneration: {
          changedSubmoduleManifests: () => Promise.resolve(["vendor/yrd/package.json"]),
          record() {
            throw new Error("must not record a regeneration that failed")
          },
        },
        fail(message): never {
          throw new Error(message)
        },
      }).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)))

      // One diagnosis, not two halves: why we retried, why the cure failed, and
      // which manifests made it necessary.
      expect(failure).toContain("registry unreachable")
      expect(failure).toContain("lockfile had changes, but lockfile is frozen")
      expect(failure).toContain("vendor/yrd/package.json")
      expect(failure).toContain("regenerating 'bun.lock' failed too")
    })

    it("leaves an unauthorized workspace on today's refusal, unchanged", async () => {
      const root = await lockedWorkspace()
      const argvs: string[][] = []
      const process = {
        run(request: ProcessRequest): Promise<ProcessResult> {
          argvs.push([...request.argv])
          return Promise.resolve(result(1, FROZEN_REFUSAL))
        },
      } satisfies Pick<Process, "run">

      // No lockfileRegeneration: a Bay is not a candidate, and nothing about it
      // may change just because candidates gained an escape hatch.
      await expect(
        ensureWorkspaceDependencies(process, {
          path: root,
          subject: "fixture workspace",
          fail(message): never {
            throw new Error(message)
          },
        }),
      ).rejects.toThrow(/could not install its dependencies/u)
      expect(argvs).toEqual([FROZEN])
    })
  })
})
