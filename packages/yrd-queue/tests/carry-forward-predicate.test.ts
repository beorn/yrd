/**
 * @failure The carry-forward predicate carries a verdict across a base motion that invalidated it, or refuses without naming why.
 * @level l1
 * @consumer @yrd/queue carry-forward predicate
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_CARRY_FORWARD_POLICY,
  carryForwardVerdict,
  isBuildAffectingPath,
  parseNameStatus,
  shadowDivergence,
  shouldShadowRecut,
  type CarryForwardGit,
  type CarryForwardRequest,
} from "@yrd/queue"

const FROM = "a".repeat(40)
const TO = "b".repeat(40)
const CANDIDATE = "c".repeat(40)

/** A git whose every answer is declared by the test. Anything the predicate
 * asks that the test did not declare fails loudly rather than defaulting. */
function fakeGit(
  answers: Readonly<{
    ancestor?: ReadonlyMap<string, boolean>
    diffs?: ReadonlyMap<string, string>
  }>,
): CarryForwardGit {
  return {
    run: (_repo, args) => {
      const argv = [...args]
      if (argv[0] === "merge-base") {
        const key = `${argv[2]}..${argv[3]}`
        const known = answers.ancestor?.get(key)
        if (known === undefined) throw new Error(`undeclared ancestry probe ${key}`)
        return Promise.resolve({ code: known ? 0 : 1, stdout: "" })
      }
      if (argv[0] === "diff") {
        const from = argv.at(-2)
        const to = argv.at(-1)
        const key = `${from}..${to}`
        const known = answers.diffs?.get(key)
        if (known === undefined) throw new Error(`undeclared diff ${key}`)
        return Promise.resolve({ code: 0, stdout: known })
      }
      throw new Error(`undeclared git call ${argv.join(" ")}`)
    },
  }
}

function request(overrides: Partial<CarryForwardRequest> = {}): CarryForwardRequest {
  return {
    repo: "/repo",
    fromBaseSha: FROM,
    toBaseSha: TO,
    candidateSha: CANDIDATE,
    evidence: { configHash: "f".repeat(64) },
    flows: [undefined],
    pins: [],
    policy: DEFAULT_CARRY_FORWARD_POLICY,
    readGitlink: () => Promise.resolve(undefined),
    ...overrides,
  }
}

/** The happy path every leg-failure case below perturbs exactly once. */
function disjointGit(motion = "M\tdocs/base.md\n", payload = "A\tsrc/feature.ts\n"): CarryForwardGit {
  return fakeGit({
    ancestor: new Map([[`${FROM}..${TO}`, true]]),
    diffs: new Map([
      [`${FROM}..${TO}`, motion],
      [`${FROM}..${CANDIDATE}`, payload],
    ]),
  })
}

describe("carry-forward predicate", () => {
  it("carries a verdict across a disjoint, forward, build-neutral motion", async () => {
    const verdict = await carryForwardVerdict(disjointGit(), request())
    expect(verdict).toMatchObject({
      carried: true,
      fromBaseSha: FROM,
      toBaseSha: TO,
      motionPaths: ["docs/base.md"],
      payloadPaths: ["src/feature.ts"],
    })
  })

  it("refuses a motion that touches the same path as the payload, naming the path", async () => {
    const verdict = await carryForwardVerdict(disjointGit("M\tsrc/feature.ts\n"), request())
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "tree-disjoint" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("src/feature.ts"))
  })

  it("refuses a motion that moves a DIRECTORY containing the payload", async () => {
    const verdict = await carryForwardVerdict(disjointGit("M\tsrc\n"), request())
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "tree-disjoint" } })
  })

  it("refuses when the motion renames, because disjointness is not cheaply provable", async () => {
    const verdict = await carryForwardVerdict(disjointGit("R100\tdocs/old.md\tdocs/new.md\n"), request())
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "tree-disjoint" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("rename"))
  })

  it("refuses when the PAYLOAD renames", async () => {
    const verdict = await carryForwardVerdict(disjointGit("M\tdocs/base.md\n", "R100\tsrc/a.ts\tsrc/b.ts\n"), request())
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "tree-disjoint" } })
  })

  it.each(["bun.lock", "package.json", "tsconfig.json", "tsconfig.hh.json", ".github/workflows/ci.yml", ".yrd.yml"])(
    "refuses a motion touching build-affecting '%s'",
    async (path) => {
      const verdict = await carryForwardVerdict(disjointGit(`M\t${path}\n`), request())
      expect(verdict).toMatchObject({ carried: false, refusal: { leg: "build-affecting-motion" } })
      expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining(path))
    },
  )

  it("refuses a base that was rewritten rather than advanced", async () => {
    const git = fakeGit({ ancestor: new Map([[`${FROM}..${TO}`, false]]) })
    const verdict = await carryForwardVerdict(git, request())
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "base-ancestry" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("rewritten"))
  })

  it("refuses when the base did not move at all", async () => {
    const verdict = await carryForwardVerdict(disjointGit(), request({ toBaseSha: FROM }))
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "base-ancestry" } })
  })

  it("refuses legacy evidence that records no check identity", async () => {
    const verdict = await carryForwardVerdict(disjointGit(), request({ evidence: {} }))
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "env-fingerprint" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("configHash"))
  })

  it("refuses when run members declare different flow pins", async () => {
    const verdict = await carryForwardVerdict(
      disjointGit(),
      request({
        flows: [
          { name: "default", rev: "1", fingerprint: "aa" },
          { name: "default", rev: "2", fingerprint: "bb" },
        ],
      }),
    )
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "env-fingerprint" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("flow pins"))
  })

  it("carries when every member shares one flow pin", async () => {
    const pin = { name: "default", rev: "1", fingerprint: "aa" }
    const verdict = await carryForwardVerdict(disjointGit(), request({ flows: [pin, { ...pin }] }))
    expect(verdict).toMatchObject({ carried: true })
  })

  it("refuses when the new base advanced a pin PAST the one the check proved", async () => {
    const pinned = "d".repeat(40)
    const advanced = "e".repeat(40)
    const git = fakeGit({
      ancestor: new Map([
        [`${FROM}..${TO}`, true],
        [`${advanced}..${pinned}`, false],
      ]),
      diffs: new Map([
        [`${FROM}..${TO}`, "M\tdocs/base.md\n"],
        [`${FROM}..${CANDIDATE}`, "A\tsrc/feature.ts\n"],
      ]),
    })
    const verdict = await carryForwardVerdict(
      git,
      request({ pins: [{ path: "vendor/dep", sha: pinned }], readGitlink: () => Promise.resolve(advanced) }),
    )
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "pin-containment" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("vendor/dep"))
  })

  it("carries when the checked pin still contains the base's pin", async () => {
    const pinned = "d".repeat(40)
    const behind = "e".repeat(40)
    const git = fakeGit({
      ancestor: new Map([
        [`${FROM}..${TO}`, true],
        [`${behind}..${pinned}`, true],
      ]),
      diffs: new Map([
        [`${FROM}..${TO}`, "M\tdocs/base.md\n"],
        [`${FROM}..${CANDIDATE}`, "A\tsrc/feature.ts\n"],
      ]),
    })
    const verdict = await carryForwardVerdict(
      git,
      request({ pins: [{ path: "vendor/dep", sha: pinned }], readGitlink: () => Promise.resolve(behind) }),
    )
    expect(verdict).toMatchObject({ carried: true })
  })

  it("refuses when the new base records no gitlink where the check proved one", async () => {
    const verdict = await carryForwardVerdict(
      disjointGit(),
      request({ pins: [{ path: "vendor/dep", sha: "d".repeat(40) }], readGitlink: () => Promise.resolve(undefined) }),
    )
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "pin-containment" } })
  })

  it("refuses when configuration disables carry-forward", async () => {
    const verdict = await carryForwardVerdict(
      disjointGit(),
      request({ policy: { ...DEFAULT_CARRY_FORWARD_POLICY, enabled: false } }),
    )
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "disabled" } })
  })

  it("refuses through the persisted kill switch and says how to clear it", async () => {
    const verdict = await carryForwardVerdict(
      disjointGit(),
      request({
        policy: {
          ...DEFAULT_CARRY_FORWARD_POLICY,
          disabledBy: { reason: "a shadow recut diverged", at: "2026-08-14T00:00:00.000Z" },
        },
      }),
    )
    expect(verdict).toMatchObject({ carried: false, refusal: { leg: "kill-switch" } })
    expect(verdict).toHaveProperty("refusal.reason", expect.stringContaining("re-enable"))
  })
})

describe("carry-forward name-status parsing", () => {
  it("keeps rename rows separate from ordinary rows", () => {
    const parsed = parseNameStatus("M\ta.ts\nR100\told.ts\tnew.ts\nA\tb.ts\n")
    expect(parsed.paths).toEqual(["a.ts", "b.ts", "new.ts", "old.ts"])
    expect(parsed.renamed).toEqual(["new.ts", "old.ts"])
  })

  it("reads an empty diff as no paths rather than one blank path", () => {
    expect(parseNameStatus("")).toEqual({ paths: [], renamed: [] })
    expect(parseNameStatus("\n\n")).toEqual({ paths: [], renamed: [] })
  })
})

describe("build-affecting classification", () => {
  it.each(["bun.lock", "packages/x/package.json", "tsconfig.json", ".github/workflows/ci.yml", "scripts/build.ts"])(
    "treats '%s' as build-affecting",
    (path) => {
      expect(isBuildAffectingPath(path)).toBe(true)
    },
  )

  it.each(["src/feature.ts", "docs/readme.md", "packages/x/src/a.ts"])("treats '%s' as ordinary", (path) => {
    expect(isBuildAffectingPath(path)).toBe(false)
  })
})

describe("shadow recut sampling", () => {
  it("never samples at rate 0 and always samples at rate 1", () => {
    expect(shouldShadowRecut({ enabled: true, shadowSampleRate: 0 }, () => 0)).toBe(false)
    expect(shouldShadowRecut({ enabled: true, shadowSampleRate: 1 }, () => 0.99)).toBe(true)
  })

  it("samples strictly below the configured fraction", () => {
    const policy = { enabled: true, shadowSampleRate: 0.1 }
    expect(shouldShadowRecut(policy, () => 0.09)).toBe(true)
    expect(shouldShadowRecut(policy, () => 0.1)).toBe(false)
  })

  it("names BOTH verdicts when the shadow diverges, and stays quiet when it agrees", () => {
    const context = { fromBaseSha: FROM, toBaseSha: TO, candidateSha: CANDIDATE }
    expect(shadowDivergence("passed", "passed", context)).toBeUndefined()
    const divergence = shadowDivergence("passed", "failed", context)
    expect(divergence).toMatchObject({ carried: "passed", fresh: "failed" })
    expect(divergence?.detail).toContain("passed")
    expect(divergence?.detail).toContain("failed")
    expect(divergence?.detail).toContain(CANDIDATE)
  })
})
