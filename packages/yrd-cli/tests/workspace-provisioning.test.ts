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
import { ensureWorkspaceDependencies } from "../src/workspace-provisioning.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function result(exitCode: number, stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, durationMs: 1, timedOut: false }
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
})
