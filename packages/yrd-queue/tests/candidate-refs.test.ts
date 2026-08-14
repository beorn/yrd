/**
 * The root Candidate ref namespace: naming, and the retention sweep.
 *
 * The sweep is judged against a FAKE `for-each-ref`, because the classification
 * is the part that decides whether evidence gets deleted and it must be readable
 * without a repository. The real-git half — that two composes publish to two
 * refs — lives in command.test.ts, where an actual repository can prove it.
 */
import { describe, expect, it } from "vitest"
import {
  CANDIDATE_REF_NAMESPACE,
  CANDIDATE_REF_RETENTION_MS,
  candidateRefFor,
  Queues,
  pruneCandidateRefs,
  sweepCandidateRefs,
  type CandidateRefSweepResult,
  type QueuesState,
} from "@yrd/queue"
import { projectionLookupFromEntries } from "../src/projection-index.ts"
import type { RefGit } from "../src/uncarried-facts.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW_MS = Date.UTC(2026, 7, 14, 12, 0, 0)
const sha = (seed: string) => seed.repeat(40).slice(0, 40)

/** A `for-each-ref` that answers from a fixture table. Anything else is a fault:
 * a sweep that quietly reads something this test did not describe is exactly the
 * bug the denominators exist to catch. */
function fakeGit(rows: readonly Readonly<{ ref: string; sha: string; ageMs?: number }>[]): RefGit {
  return {
    async run(_repo, args) {
      if (args[0] !== "for-each-ref" || args[2] !== CANDIDATE_REF_NAMESPACE) {
        throw new Error(`unexpected git read in this fixture: ${args.join(" ")}`)
      }
      return rows
        .map((row) =>
          [row.ref, row.sha, row.ageMs === undefined ? "" : String(Math.floor((NOW_MS - row.ageMs) / 1000))].join("\0"),
        )
        .join("\n")
    },
    async optional() {
      throw new Error("the sweep must not need optional reads")
    },
  }
}

/**
 * A projection carrying the Candidate and Run facts the sweep consults.
 *
 * Built on `Queues.empty` and the REAL lookup constructor. A hand-rolled
 * `records` object type-asserts cleanly and then reads back empty, which would
 * make every terminal case here pass for the wrong reason — the run would be
 * invisible rather than terminal.
 */
function queuesWith(
  candidates: readonly Readonly<{ id: string; sha: string; ref?: string }>[],
  runs: readonly Readonly<{ id: string; candidateId: string; terminal: boolean }>[],
): QueuesState {
  const base = Queues.empty({ batchSize: 1 })
  return {
    ...base,
    candidates: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        {
          id: candidate.id,
          queueId: "main",
          baseSha: sha("0"),
          revs: [],
          sha: candidate.sha,
          ref: candidate.ref ?? candidateRefFor(candidate.sha),
          mergeability: "mergeable" as const,
          createdAt: new Date(NOW_MS).toISOString(),
        },
      ]),
    ),
    records: projectionLookupFromEntries(
      runs.map((run) => ({
        key: run.id,
        value: {
          id: run.id,
          queueId: "main",
          candidateId: run.candidateId,
          prs: [],
          base: "main",
          steps: [],
          startedAt: new Date(NOW_MS).toISOString(),
          // `passedAt` is one of the three terminal stamps a record carries.
          ...(run.terminal ? { passedAt: new Date(NOW_MS).toISOString() } : {}),
        },
      })),
    ),
  }
}

/** Guards the fixture itself: if the runs are not readable, every terminal
 * assertion below would pass vacuously. */
function expectRunsAreVisible(queues: QueuesState, expected: number): void {
  expect(Queues.values(queues)).toHaveLength(expected)
}

/** scanned must equal the buckets, always. A ref in no bucket is under-reporting
 * and a ref in two is double-counting; both make the numbers unusable. */
function expectBucketsSumToScanned(result: CandidateRefSweepResult): void {
  expect(result.live + result.withinRetention + result.reclaimable + result.unclaimed + result.noClock).toBe(
    result.scanned,
  )
}

describe("candidate refs", () => {
  it("names a ref after the evidence it holds", () => {
    expect(candidateRefFor(sha("a"))).toBe(`${CANDIDATE_REF_NAMESPACE}/${sha("a")}`)
    // Different evidence can never collide, which is the whole 22332 fix.
    expect(candidateRefFor(sha("a"))).not.toBe(candidateRefFor(sha("b")))
  })

  it("states a seven-day retention window, matching the source-candidate ref rule", () => {
    expect(CANDIDATE_REF_RETENTION_MS).toBe(7 * DAY_MS)
  })

  it("retains a ref whose Run has not reached a terminal status, however old it is", async () => {
    const live = sha("1")
    const queues = queuesWith([{ id: "C1", sha: live }], [{ id: "R1", candidateId: "C1", terminal: false }])
    expectRunsAreVisible(queues, 1)

    const result = await sweepCandidateRefs(fakeGit([{ ref: candidateRefFor(live), sha: live, ageMs: 400 * DAY_MS }]), {
      repo: "/repo",
      queues,
      nowMs: NOW_MS,
    })

    expect(result.live).toBe(1)
    expect(result.reclaimable).toBe(0)
    expect(result.findings).toEqual([])
    expectBucketsSumToScanned(result)
  })

  it("retains a terminal ref inside the window and reclaims it once past", async () => {
    const fresh = sha("2")
    const aged = sha("3")
    const rows = [
      { ref: candidateRefFor(fresh), sha: fresh, ageMs: 6 * DAY_MS },
      { ref: candidateRefFor(aged), sha: aged, ageMs: 8 * DAY_MS },
    ]
    const queues = queuesWith(
      [
        { id: "C1", sha: fresh },
        { id: "C2", sha: aged },
      ],
      [
        { id: "R1", candidateId: "C1", terminal: true },
        { id: "R2", candidateId: "C2", terminal: true },
      ],
    )
    expectRunsAreVisible(queues, 2)

    const result = await sweepCandidateRefs(fakeGit(rows), { repo: "/repo", queues, nowMs: NOW_MS })

    expect(result.withinRetention).toBe(1)
    expect(result.reclaimable).toBe(1)
    expect(result.findings).toEqual([
      expect.objectContaining({
        ref: candidateRefFor(aged),
        sha: aged,
        disposition: "reclaimable",
        candidateId: "C2",
      }),
    ])
    expect(result.findings[0]?.message).toContain("7-day retention window")
    expectBucketsSumToScanned(result)
  })

  it("reports a ref no journaled Candidate claims, and never calls it reclaimable", async () => {
    // The ~2000-ref case: `compactQueuesState` bounds terminal run trees, so the
    // journal can no longer explain an old ref at all. Terminality is unprovable,
    // so the ruling in docs/design.md keeps it.
    const orphan = sha("4")
    const result = await sweepCandidateRefs(
      fakeGit([{ ref: `${CANDIDATE_REF_NAMESPACE}/C17`, sha: orphan, ageMs: 900 * DAY_MS }]),
      { repo: "/repo", queues: queuesWith([], []), nowMs: NOW_MS },
    )

    expect(result.unclaimed).toBe(1)
    expect(result.reclaimable).toBe(0)
    expect(result.findings).toEqual([
      expect.objectContaining({ ref: `${CANDIDATE_REF_NAMESPACE}/C17`, disposition: "unclaimed" }),
    ])
    expect(result.findings[0]?.message).toContain("terminality cannot be proven")
    expectBucketsSumToScanned(result)
  })

  it("recognises a legacy id-named ref through the Candidate that recorded it", async () => {
    // Refs published before 22332 are named `C<n>`. The journal still holds that
    // exact ref string, so they age out on the same rule rather than being
    // stranded as permanently unclaimed.
    const legacy = sha("5")
    const legacyRef = `${CANDIDATE_REF_NAMESPACE}/C9`
    const result = await sweepCandidateRefs(fakeGit([{ ref: legacyRef, sha: legacy, ageMs: 30 * DAY_MS }]), {
      repo: "/repo",
      queues: queuesWith([{ id: "C9", sha: legacy, ref: legacyRef }], [{ id: "R9", candidateId: "C9", terminal: true }]),
      nowMs: NOW_MS,
    })

    expect(result.reclaimable).toBe(1)
    expect(result.findings[0]).toMatchObject({ ref: legacyRef, disposition: "reclaimable", candidateId: "C9" })
    expectBucketsSumToScanned(result)
  })

  it("retains a ref with no readable clock rather than guessing its age", async () => {
    const unclocked = sha("6")
    const result = await sweepCandidateRefs(fakeGit([{ ref: candidateRefFor(unclocked), sha: unclocked }]), {
      repo: "/repo",
      queues: queuesWith([{ id: "C1", sha: unclocked }], [{ id: "R1", candidateId: "C1", terminal: true }]),
      nowMs: NOW_MS,
    })

    expect(result.noClock).toBe(1)
    expect(result.reclaimable).toBe(0)
    expect(result.findings[0]).toMatchObject({ disposition: "no-clock" })
    expectBucketsSumToScanned(result)
  })

  it("reports its denominators so an empty finding list can be believed", async () => {
    const result = await sweepCandidateRefs(fakeGit([]), { repo: "/repo", queues: queuesWith([], []), nowMs: NOW_MS })

    expect(result).toMatchObject({
      findings: [],
      scanned: 0,
      live: 0,
      withinRetention: 0,
      reclaimable: 0,
      unclaimed: 0,
      noClock: 0,
    })
  })

  describe("pruning", () => {
    /** A git that records deletes and answers `rev-parse` from a mutable table. */
    function pruneGit(refs: Map<string, string>) {
      const deletes: string[] = []
      const git: RefGit = {
        async run() {
          throw new Error("the prune pass must only use optional reads")
        },
        async optional(_repo, args) {
          if (args[0] === "rev-parse") {
            const ref = (args[2] ?? "").replace(/\^\{commit\}$/u, "")
            return refs.get(ref)
          }
          if (args[0] === "update-ref" && args[1] === "-d") {
            const [, , ref, expected] = args
            if (ref === undefined || refs.get(ref) !== expected) return undefined
            refs.delete(ref)
            deletes.push(ref)
            return ""
          }
          throw new Error(`unexpected git call: ${args.join(" ")}`)
        },
      }
      return { git, deletes }
    }

    /** The end-to-end shape of the acceptance: a terminal Candidate past the
     * seven-day window is inventoried, then actually removed from the repository. */
    it("ages out a terminal ref past the retention window", async () => {
      const aged = sha("8")
      const ref = candidateRefFor(aged)
      const queues = queuesWith([{ id: "C1", sha: aged }], [{ id: "R1", candidateId: "C1", terminal: true }])
      expectRunsAreVisible(queues, 1)

      const swept = await sweepCandidateRefs(fakeGit([{ ref, sha: aged, ageMs: 8 * DAY_MS }]), {
        repo: "/repo",
        queues,
        nowMs: NOW_MS,
      })
      expect(swept.reclaimable).toBe(1)

      const refs = new Map([[ref, aged]])
      const { git, deletes } = pruneGit(refs)
      const result = await pruneCandidateRefs(git, { repo: "/repo", findings: swept.findings })

      expect(result.deleted).toEqual([ref])
      expect(result.kept).toEqual([])
      expect(deletes).toEqual([ref])
      expect(refs.has(ref)).toBe(false)
    })

    it("keeps a reclaimable ref that moved between the inventory and the delete", async () => {
      const judged = sha("9")
      const moved = sha("c")
      const ref = candidateRefFor(judged)
      const findings = [
        { ref, sha: judged, disposition: "reclaimable" as const, candidateId: "C1", message: "past the window" },
      ]

      // The repository now holds something else at that name.
      const refs = new Map([[ref, moved]])
      const { git, deletes } = pruneGit(refs)
      const result = await pruneCandidateRefs(git, { repo: "/repo", findings })

      expect(result.deleted).toEqual([])
      expect(result.kept).toEqual([{ ref, reason: `moved since the inventory read (now ${moved})` }])
      expect(deletes).toEqual([])
      expect(refs.get(ref)).toBe(moved)
    })

    it("never deletes a ref the sweep did not call reclaimable", async () => {
      // Unclaimed, live, within-retention and unclocked refs are all retained —
      // the reaper acts only on POSITIVE proof.
      const kept = sha("d")
      const ref = candidateRefFor(kept)
      const refs = new Map([[ref, kept]])
      const { git, deletes } = pruneGit(refs)

      for (const disposition of ["unclaimed", "live", "within-retention", "no-clock"] as const) {
        const result = await pruneCandidateRefs(git, {
          repo: "/repo",
          findings: [{ ref, sha: kept, disposition, message: "retained" }],
        })
        expect(result.deleted).toEqual([])
      }

      expect(deletes).toEqual([])
      expect(refs.get(ref)).toBe(kept)
    })
  })

  it("honours an overridden retention window", async () => {
    const aged = sha("7")
    const options = {
      repo: "/repo",
      queues: queuesWith([{ id: "C1", sha: aged }], [{ id: "R1", candidateId: "C1", terminal: true }]),
      nowMs: NOW_MS,
    }
    const rows = [{ ref: candidateRefFor(aged), sha: aged, ageMs: 3 * DAY_MS }]

    expect((await sweepCandidateRefs(fakeGit(rows), options)).reclaimable).toBe(0)
    expect((await sweepCandidateRefs(fakeGit(rows), { ...options, retentionMs: 2 * DAY_MS })).reclaimable).toBe(1)
  })
})
