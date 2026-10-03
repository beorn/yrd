/**
 * @failure  the queue's git-super is resolved from the ambient PATH, or the queue
 *           silently falls back to `git super` when the launcher froze none, so a
 *           candidate moving vendor/git-super supplies the executable that gets
 *           the push authority and writes the success JSON (27098).
 * @level    l2 — the real runner, a real stub binary, and a recording Process.
 * @consumer @i/10-yrd/27098-a-defect-in-the-queues-landing-code-blocks-its-own-revert-publication-runs-the-bases-pinned-git-super
 * @testonly none
 */
import { createProcess } from "@yrd/process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { gitIn, type GitSelection } from "../src/git.ts"
import {
  frozenGitSuperSelection,
  requireFrozenGitSuper,
  withGitConfig,
  YRD_GIT_SUPER_BIN,
  YRD_GIT_SUPER_SHA,
} from "../src/git-super-selection.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "git-super-selection-"))
  roots.push(path)
  return path
}

/** A stub frozen binary that settles like a git-super child. */
function stubBin(dir: string, name = "git-super"): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, name)
  writeFileSync(bin, '#!/bin/sh\necho "{}"\n', { mode: 0o755 })
  chmodSync(bin, 0o755)
  return bin
}

const NATIVE: GitSelection = Object.freeze({
  executable: "git",
  contract: "native",
  scope: "default",
  origin: "fixture",
})

describe("27098: the queue's frozen git-super selection", () => {
  it("is undefined only when the launcher set neither variable", () => {
    expect(frozenGitSuperSelection({})).toBeUndefined()
    const bin = stubBin(join(root(), "bin"))
    expect(frozenGitSuperSelection({ [YRD_GIT_SUPER_BIN]: bin, [YRD_GIT_SUPER_SHA]: "a".repeat(40) })).toEqual({
      bin,
      sha: "a".repeat(40),
    })
  })

  it("refuses a half-declared, relative, non-oid, missing or non-executable selection", () => {
    const dir = root()
    const bin = stubBin(join(dir, "bin"))
    const sha = "a".repeat(40)
    expect(() => frozenGitSuperSelection({ [YRD_GIT_SUPER_BIN]: bin })).toThrow(/sets both or neither/u)
    expect(() => frozenGitSuperSelection({ [YRD_GIT_SUPER_SHA]: sha })).toThrow(/sets both or neither/u)
    expect(() =>
      frozenGitSuperSelection({ [YRD_GIT_SUPER_BIN]: "vendor/git-super", [YRD_GIT_SUPER_SHA]: sha }),
    ).toThrow(/not an absolute path/u)
    expect(() => frozenGitSuperSelection({ [YRD_GIT_SUPER_BIN]: bin, [YRD_GIT_SUPER_SHA]: "nope" })).toThrow(
      /not a commit oid/u,
    )
    expect(() =>
      frozenGitSuperSelection({ [YRD_GIT_SUPER_BIN]: join(dir, "absent"), [YRD_GIT_SUPER_SHA]: sha }),
    ).toThrow(/is missing/u)
    const plain = join(dir, "plain")
    writeFileSync(plain, "not executable\n")
    expect(() => frozenGitSuperSelection({ [YRD_GIT_SUPER_BIN]: plain, [YRD_GIT_SUPER_SHA]: sha })).toThrow(
      /is not executable/u,
    )
  })

  it("refuses a queue that was launched with no frozen selection, never falling back", () => {
    expect(() => requireFrozenGitSuper({}, "git-super push")).toThrow(
      /no frozen git-super selection for git-super push/u,
    )
  })

  it("appends the queue's hooks configuration after any inherited entries", () => {
    const composed = withGitConfig({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a", GIT_CONFIG_VALUE_0: "1" }, [
      "core.hooksPath=/queue/hooks-disabled",
    ])
    expect(composed).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/queue/hooks-disabled",
    })
  })

  it("runs the frozen absolute binary directly and never re-reads a changed process.env", async () => {
    const dir = root()
    const frozen = stubBin(join(dir, "frozen"))
    const poisoned = stubBin(join(dir, "poisoned"))
    const seen: readonly string[][] = []
    const real = createProcess({ cwd: dir })
    try {
      const recording = {
        ...real,
        async run(request: Parameters<typeof real.run>[0]) {
          ;(seen as string[][]).push([...request.argv])
          return real.run(request)
        },
      }
      const git = gitIn(dir, recording, NATIVE, {
        env: { ...process.env, [YRD_GIT_SUPER_BIN]: frozen, [YRD_GIT_SUPER_SHA]: "a".repeat(40) },
      })
      // A later mutation must not move the selected tool: the runner captured it.
      const prior = process.env[YRD_GIT_SUPER_BIN]
      process.env[YRD_GIT_SUPER_BIN] = poisoned
      try {
        await git(["super", "merge", "candidate", "-m", "message"])
      } finally {
        if (prior === undefined) delete process.env[YRD_GIT_SUPER_BIN]
        else process.env[YRD_GIT_SUPER_BIN] = prior
      }
      expect(seen).toHaveLength(1)
      expect(seen[0]?.[0]).toBe(frozen)
      expect(seen[0]).not.toContain("super")
    } finally {
      await real.close()
    }
  })

  it("refuses a git-super child on a runner built with no frozen selection", async () => {
    const dir = root()
    const real = createProcess({ cwd: dir })
    try {
      const git = gitIn(dir, real, NATIVE, { env: {} })
      await expect(git(["super", "merge", "candidate", "-m", "message"])).rejects.toThrow(
        /no frozen git-super selection/u,
      )
    } finally {
      await real.close()
    }
  })
})
