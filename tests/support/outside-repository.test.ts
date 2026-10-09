/**
 * @failure A fixture built with `mkdtempSync(join(tmpdir(), …))` is treated as "outside any
 *          repository" although TMPDIR sits inside one, so Git discovers the host repository and
 *          the fixture passes over the no-repository case it means to exercise; worse, any unrelated
 *          nonzero Git exit is read as proof of absence (28434).
 * @level   l2 (a real `git rev-parse --git-dir`, in a directory outside a repository and in one inside)
 * @consumer the yrd fixtures that build an "outside any repository" directory
 * @testonly none
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { assertOutsideRepository, outsideRepositoryRoot } from "./outside-repository.ts"

const roots: string[] = []

afterEach(() => {
  // raw-delete-allow: the fixture roots these rows made with outsideRepositoryRoot or mkdtemp, and nothing else
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A base INSIDE a repository, for the refusal rows: this checkout's own node_modules. */
function insideARepository(): string {
  return join(process.cwd(), "node_modules")
}

describe("outsideRepositoryRoot (28434)", () => {
  it("returns a directory the callers' own local read fails in, whatever TMPDIR is", () => {
    const directory = outsideRepositoryRoot("yrd-outside-repository-test-")
    roots.push(directory)
    // The premise every caller asserts: a local Git read here must fail, not discover a repository.
    expect(spawnSync("git", ["rev-parse", "--git-dir"], { cwd: directory, encoding: "utf8" }).status).not.toBe(0)
  })

  it("refuses a directory that is inside a repository, naming the repository", () => {
    expect(() => assertOutsideRepository(insideARepository())).toThrow(/is inside the Git repository at/u)
  })

  it("refuses loudly when every base is inside a repository, naming each base", () => {
    const inside = mkdtempSync(join(insideARepository(), "yrd-inside-"))
    roots.push(inside)
    expect(() => outsideRepositoryRoot("yrd-outside-repository-none-", [inside])).toThrow(
      /no directory outside every Git repository could be built/u,
    )
  })

  it("refuses an unexpected native Git failure instead of certifying the directory (28434)", () => {
    // A Git that fails for a reason OTHER than "not a git repository" — here a config parse error —
    // proves nothing about absence, so neither the assertion nor the builder may read it as outside.
    const saved = process.env.GIT_CONFIG_COUNT
    process.env.GIT_CONFIG_COUNT = "invalid"
    try {
      expect(() => assertOutsideRepository(insideARepository())).toThrow(
        /could not prove .* is outside every Git repository: .+/u,
      )
      expect(() => outsideRepositoryRoot("yrd-outside-repository-unproven-", [insideARepository()])).toThrow(
        /no directory outside every Git repository could be built/u,
      )
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_COUNT
      else process.env.GIT_CONFIG_COUNT = saved
    }
  })
})
