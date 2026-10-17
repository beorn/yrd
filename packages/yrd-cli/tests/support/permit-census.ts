import { vi } from "vitest"
import * as removely from "removely"

/** A complete host census for fixtures whose contract excludes unrelated processes. */
export async function permitCensus() {
  const actual = await vi.importActual<typeof import("removely")>("removely")
  const observed = await actual.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 })
  const permitted = { ...observed, rows: [], coverage: { ...observed.coverage, complete: true, unreadable: [] } }
  const spy = vi.spyOn(removely, "inspectProcessCensus").mockResolvedValue(permitted)
  return { spy, permitted }
}
