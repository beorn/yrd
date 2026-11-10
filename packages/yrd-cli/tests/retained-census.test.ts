/**
 * @failure The retained-modules store grows past every recorded retainUntil and nobody can tell without a du walk
 *   (#33010): the census miscounts live versus expired stores, reads a malformed or absent deadline as expired,
 *   silently drops a store with no manifest, or reports an absent root as an empty one.
 * @level l1 (pure census over a temporary retained root)
 * @consumer yrd env retained; the #33010 drain dry-run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { censusRetainedStores } from "../src/retained-census.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const NOW = Date.parse("2026-11-10T12:00:00.000Z")

function store(root: string, name: string, manifest: unknown): void {
  mkdirSync(join(root, name, "modules"), { recursive: true })
  if (manifest !== undefined) {
    writeFileSync(
      join(root, name, "manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    )
  }
}

test("counts live, expired, legacy, malformed and manifest-less stores by name, without reading sizes", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-census-"))
  roots.push(root)
  store(root, "live-a", { retainUntil: "2026-11-12T00:00:00.000Z", writerLocks: [] })
  store(root, "expired-a", { retainUntil: "2026-11-01T00:00:00.000Z", writerLocks: [] })
  store(root, "expired-b", { retainUntil: "2026-10-02T16:56:18.000Z", writerLocks: [] })
  store(root, "expired-legacy", { retainUntil: "2026-10-01T00:00:00.000Z" })
  store(root, "no-deadline", { writerLocks: [] })
  store(root, "bad-deadline", { retainUntil: "soon", writerLocks: [] })
  store(root, "torn", "{")
  store(root, "no-manifest", undefined)

  const census = censusRetainedStores(root, NOW)

  expect(census).toMatchObject({
    root,
    state: "read",
    total: 8,
    live: 1,
    expired: 3,
    expiredLegacy: 1,
    oldestExpired: "2026-10-01T00:00:00.000Z",
  })
  expect(census.state === "read" && census.malformed.map((entry) => entry.name).sort()).toEqual([
    "bad-deadline",
    "no-deadline",
    "torn",
  ])
  expect(census.state === "read" && census.noManifest).toEqual(["no-manifest"])
})

test("an absent retained root is named, never read as an empty store", () => {
  const missing = join(tmpdir(), "retained-census-absent-33010")
  expect(censusRetainedStores(missing, NOW)).toEqual({ root: missing, state: "absent" })
})
