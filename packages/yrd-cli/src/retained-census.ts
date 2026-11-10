/**
 * The retained-modules census (#33010): how many stores `env close` retained are still inside their own recorded
 * `retainUntil`, how many are past it, and which cannot be classified, read from each store's manifest only, with no
 * size walk. A store past its deadline is a retirement candidate for git-super's own remover, which re-proves it
 * per entry; this census decides nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type RetainedCensus =
  | Readonly<{ root: string; state: "absent" }>
  | Readonly<{
      root: string
      state: "read"
      total: number
      live: number
      /** Past `retainUntil`, legacy manifests included. */
      expired: number
      /** Expired, but the manifest predates `writerLocks`; git-super keeps these as legacy-unrecorded. */
      expiredLegacy: number
      oldestExpired: string | null
      /** A manifest with no, or an unparseable, `retainUntil`, or one that is not JSON: never a candidate. */
      malformed: readonly Readonly<{ name: string; reason: string }>[]
      /** A store directory with no `manifest.json`: never a candidate. */
      noManifest: readonly string[]
    }>

/**
 * The one line `env close` prints after retaining (@cto dc77f630): a directory count only, because the full census
 * parses every manifest (9.7 s on the live 8,560-store root) and close must stay fast. It points at the full census.
 */
export function retainedCloseLine(root: string): string {
  if (!existsSync(root)) return `no retained stores: ${root} does not exist`
  const stores = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  return `${stores} retained store(s) under ${root}; yrd env retained counts the expired ones`
}

export function censusRetainedStores(root: string, now: number): RetainedCensus {
  if (!existsSync(root)) return { root, state: "absent" }
  let live = 0
  let expired = 0
  let expiredLegacy = 0
  let oldest: { at: number; text: string } | null = null
  const malformed: { name: string; reason: string }[] = []
  const noManifest: string[] = []
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  for (const name of names) {
    const path = join(root, name, "manifest.json")
    if (!existsSync(path)) {
      noManifest.push(name)
      continue
    }
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      malformed.push({ name, reason: `manifest is not JSON: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const record = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>) : {}
    const retainUntil = record.retainUntil
    const at = typeof retainUntil === "string" ? Date.parse(retainUntil) : Number.NaN
    if (typeof retainUntil !== "string" || Number.isNaN(at)) {
      malformed.push({
        name,
        reason:
          retainUntil === undefined ? "manifest records no retainUntil" : `retainUntil ${JSON.stringify(retainUntil)} is not a date`,
      })
      continue
    }
    if (at > now) {
      live++
      continue
    }
    expired++
    if (!("writerLocks" in record)) expiredLegacy++
    if (oldest === null || at < oldest.at) oldest = { at, text: retainUntil }
  }
  return {
    root,
    state: "read",
    total: names.length,
    live,
    expired,
    expiredLegacy,
    oldestExpired: oldest?.text ?? null,
    malformed,
    noManifest,
  }
}
