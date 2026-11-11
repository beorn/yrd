/**
 * @failure The retained-modules store grows past every recorded retainUntil and nobody can tell without a du walk
 *   (#33010): the census miscounts live versus expired stores, reads a malformed or absent deadline as expired,
 *   silently drops a store with no manifest, or reports an absent root as an empty one.
 * @level l1 (pure census over a temporary retained root)
 * @consumer yrd env retained; the #33010 drain dry-run.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { censusRetainedStores, retainedCloseLine } from "../src/retained-census.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const NOW = Date.parse("2026-11-10T12:00:00.000Z")

function store(root: string, name: string, manifest: unknown): void {
  mkdirSync(join(root, name, "modules"), { recursive: true })
  if (manifest !== undefined) {
    writeFileSync(join(root, name, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest))
  }
}

test("counts live, expired, legacy, malformed and manifest-less stores by name, without reading sizes", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-census-"))
  roots.push(root)
  store(root, "live-a", { retainUntil: "2026-11-12T00:00:00.000Z", writerLocks: [] })
  store(root, "expired-a", { retainUntil: "2026-11-01T00:00:00.000Z", writerLocks: [], notCompared: [] })
  store(root, "expired-b", { retainUntil: "2026-10-02T16:56:18.000Z", writerLocks: [], notCompared: [] })
  store(root, "expired-missing-notCompared", { retainUntil: "2026-11-01T00:00:00.000Z", writerLocks: [] })
  store(root, "expired-legacy", { retainUntil: "2026-10-01T00:00:00.000Z" })
  store(root, "no-deadline", { writerLocks: [] })
  store(root, "bad-deadline", { retainUntil: "soon", writerLocks: [] })
  store(root, "torn", "{")
  store(root, "no-manifest", undefined)
  // A partial retirement leaves module files but no manifest; it must stay outside expiredEntries.
  writeFileSync(join(root, "no-manifest", "modules", "leftover-object"), "interrupted removal\n")

  const census = censusRetainedStores(root, NOW)

  expect(census).toMatchObject({
    root,
    state: "read",
    total: 9,
    live: 1,
    expired: 4,
    expiredLegacy: 1,
    expiredMissingNotCompared: ["expired-missing-notCompared"],
    oldestExpired: "2026-10-01T00:00:00.000Z",
  })
  expect(census.state === "read" && census.malformed.map((entry) => entry.name).sort()).toEqual([
    "bad-deadline",
    "no-deadline",
    "torn",
  ])
  expect(census.state === "read" && census.noManifest).toEqual(["no-manifest"])
  expect(census.state === "read" && [...census.expiredEntries].sort()).toEqual(["expired-a", "expired-b"])
})

/**
 * @failure A crash preparation is indistinguishable from damaged published custody, or its marker authorizes retirement.
 * @level l1 @consumer yrd env retained and the existing retained retirement selection (31301)
 * The existing census table has only unmarked manifest-less entries and cannot identify a preparation's age/source.
 */
test("names unpublished preparations while valid manifests win and retirement selection stays unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-census-preparing-"))
  roots.push(root)
  const marker = {
    version: 1,
    state: "preparing",
    sourceGitDir: "/source/admin",
    createdAt: "2026-11-10T10:00:00.000Z",
  }
  store(root, "preparing", undefined)
  store(root, "interrupted-publication", "{")
  store(root, "published-with-marker", { retainUntil: "2026-11-01T00:00:00.000Z", writerLocks: [], notCompared: [] })
  store(root, "unmarked-unknown", undefined)
  for (const name of ["preparing", "interrupted-publication", "published-with-marker"]) {
    writeFileSync(join(root, name, "preparation.json"), JSON.stringify(marker))
  }

  const census = censusRetainedStores(root, NOW)
  expect(census.state).toBe("read")
  if (census.state !== "read") throw new Error("fixture retained root was not read")
  expect(census).toMatchObject({
    unpublished: [
      {
        name: "interrupted-publication",
        sourceGitDir: marker.sourceGitDir,
        createdAt: marker.createdAt,
        reason: "interrupted publication",
      },
      { name: "preparing", sourceGitDir: marker.sourceGitDir, createdAt: marker.createdAt, reason: "preparing" },
    ],
  })
  expect([...census.noManifest].sort()).toEqual(["preparing", "unmarked-unknown"])
  expect(census.malformed).toEqual([
    expect.objectContaining({
      name: "interrupted-publication",
      reason: expect.stringContaining("interrupted publication"),
    }),
  ])
  // Existing selection still takes only manifest-backed writerLocks + notCompared; the marker contributes no authority.
  expect(census.expiredEntries).toEqual(["published-with-marker"])
  expect(census.expired).toBe(1)
})

// @cto dc77f630: env close prints the census line only. A full census parses every manifest (9.7 s on the live
// 8,560-store root), so the close line counts store directories alone and points at the full census.
test("the env close line counts store directories without reading manifests and names the full census", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-census-line-"))
  roots.push(root)
  store(root, "a", { retainUntil: "2026-11-01T00:00:00.000Z" })
  store(root, "torn", "{")
  writeFileSync(join(root, "stray-file"), "not a store\n")
  expect(retainedCloseLine(root)).toBe(`2 retained store(s) under ${root}; yrd env retained counts the expired ones`)
  const missing = join(tmpdir(), "retained-census-line-absent-33010")
  expect(retainedCloseLine(missing)).toBe(`no retained stores: ${missing} does not exist`)
})

test("an absent retained root is named, never read as an empty store", () => {
  const missing = join(tmpdir(), "retained-census-absent-33010")
  expect(censusRetainedStores(missing, NOW)).toEqual({ root: missing, state: "absent" })
})
