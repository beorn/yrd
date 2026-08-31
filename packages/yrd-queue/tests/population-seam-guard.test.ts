/**
 * @failure  A reader indexes or iterates `BaysState.prs` raw and silently
 *           reads ONE lane as if it were the population: post-S6 the record
 *           store is not the population (a refs/for push mints no record), so
 *           a raw `Object.values(bays.prs)` answers "the changes" with the
 *           record lane alone — the defect that made `yrd pr view PR2706`
 *           report `no change` while the queue was running PR2706's checks.
 *           C3a routed every raw read through named lane-explicit accessors;
 *           this guard is the ratchet that keeps it routed.
 * @level    l1 (a line scan over packages/*'s src; no git, no TypeScript
 *           program, no module load)
 * @consumer @i/10-yrd plan C3 (C3a exit criterion: raw reads -> named residual)
 *
 * THE SEAM, which may touch the shape raw, because owning a shape means
 * owning the questions about it:
 *   - yrd-bay/src/model.ts        (getChangeRecord / recordChanges /
 *                                  recordChangeEntries / recordChangeCount /
 *                                  recordLaneOwnsBranch — the record lane's
 *                                  accessor family, plus the store's own
 *                                  reducers)
 *   - yrd-queue/src/change-population.ts (queueChanges / queueChangeCount /
 *                                  pendingSubmitBranches — the both-lanes
 *                                  population)
 *
 * NAMED EXCEPTIONS — raw-map ARGUMENT passes, not reads; both are C3c's to
 * retire when the lane fold changes the signatures:
 *   - derived-member.ts passes the map to `mintChangeId`, which reads the id
 *     KEY SPACE (max-id computation), not the population.
 *   - run.ts passes the map to `planRefusalRemedies` (refusal-remedy.ts),
 *     which correlates admission refusals to records.
 *
 * Comments are free: a line whose trimmed start is `*`, `//` or `/*` never
 * fires. The façade method `app.bays.prs()` is a NAMED record-lane read and
 * does not match the raw patterns; whether its callers should see both lanes
 * is C3b's question, per site, with tests.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(import.meta.dirname, "../../../")
const PACKAGES = join(REPO_ROOT, "packages")

/** Files allowed to touch `bays.prs` raw — the seam. */
const SEAM = new Set(["yrd-bay/src/model.ts", "yrd-queue/src/change-population.ts"])

/** Exact expressions allowed outside the seam (argument passes, named above). */
const EXCEPTIONS = new Set([
  "mintChangeId(mint, bays.prs)",
  "planRefusalRemedies(snapshot.queues.admissionRefusals, snapshot.bays.prs, attempted)",
])

/** Raw read shapes: iteration and indexing of the record store. */
const RAW = [/Object\.(?:values|keys|entries)\((?:[\w$.()\s]*\.)?bays\.prs\)/, /\bbays\.prs\[/]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue
      out.push(...sourceFiles(path))
    } else if (entry.endsWith(".ts") && path.includes("/src/")) {
      out.push(path)
    }
  }
  return out
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")
}

type Hit = Readonly<{ file: string; line: number; text: string }>

function rawHits(): { seam: Hit[]; offenders: Hit[] } {
  const seam: Hit[] = []
  const offenders: Hit[] = []
  for (const path of sourceFiles(PACKAGES)) {
    const file = relative(PACKAGES, path)
    const lines = readFileSync(path, "utf-8").split("\n")
    lines.forEach((text, index) => {
      if (isComment(text)) return
      if (!RAW.some((pattern) => pattern.test(text))) return
      const hit = { file, line: index + 1, text: text.trim() }
      if (SEAM.has(file)) seam.push(hit)
      else if (![...EXCEPTIONS].some((exception) => text.includes(exception))) offenders.push(hit)
    })
  }
  return { seam, offenders }
}

describe("population seam guard — raw bays.prs reads live only at the seam", () => {
  it("no raw read of the record store outside the seam", () => {
    const { offenders } = rawHits()
    expect(
      offenders.map((hit) => `${hit.file}:${String(hit.line)}  ${hit.text}`),
      "a raw bays.prs read outside the seam reads ONE lane as the population — " +
        "route it through recordChanges/recordChangeCount/recordChangeEntries/getChangeRecord (@yrd/bay, record lane) " +
        "or queueChanges/resolveQueueChange (yrd-queue change-population.ts, both lanes)",
    ).toEqual([])
  })

  it("positive control: the seam itself still matches, so the patterns are live", () => {
    const { seam } = rawHits()
    const files = new Set(seam.map((hit) => hit.file))
    // Both seam files must contribute at least one raw read; a refactor that
    // moves the seam updates SEAM here consciously, and a regex change that
    // stops matching anything fails HERE rather than passing the ban above.
    expect(files, "seam files no longer match the raw patterns — the guard went blind").toEqual(new Set(SEAM))
  })
})
