/**
 * @reach bundle <a Bun.build metafile over the real CLI entry, resolved against this checkout>
 * @failure  The relaunch exit and hab's source check watch only the paths
 *           `runtime-components.ts` names. A new in-process import from a vendor
 *           root that module does not name goes unwatched: the runtime loads it,
 *           a promotion can move it, and neither observer sees it — the exact
 *           blindness 27886 exists to close.
 * @level    l2 (the real runtime's module graph, bundled; no mocks)
 * @consumer every seat whose landed yrd change is not actually running, and hab's
 *           source check, which reads the same constant
 * @testonly none: the bundle seam is Bun's, and the constant is production code
 */
import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { YRD_RUNTIME_COMPONENTS, YRD_RUNTIME_OWN_COMPONENT } from "../src/runtime-components.ts"

/** The yrd checkout: `packages/yrd-queue-core/tests` walks up three levels. */
const yrdRoot = resolve(import.meta.dirname, "..", "..", "..")
/**
 * The constant only has meaning where the vendor gitlinks exist BESIDE yrd: the
 * hh monorepo, where a superproject records every one of them. In a standalone
 * yrd clone there is no superproject, `runtimeGitlinkPath` is off, and no vendor
 * root can be reached by the runtime at all — the property below is vacuous, and
 * asserting it would be a lie in either direction.
 */
const vendorLayout = existsSync(resolve(yrdRoot, "..", "silvery")) && existsSync(resolve(yrdRoot, "..", "bearly"))

describe.skipIf(!vendorLayout)("yrd runtime components (27886)", () => {
  it("names every vendor root the runtime's module graph reaches", async () => {
    const build = await Bun.build({
      entrypoints: [join(yrdRoot, "bin/yrd.ts")],
      target: "bun",
      metafile: true,
      throw: false,
    })
    const metafile = (build as unknown as { metafile?: { inputs?: Record<string, unknown> } }).metafile
    expect(build.success, build.logs.map((entry) => String(entry.message ?? entry)).join("; ")).toBe(true)
    // A metafile input path is relative to the process cwd at build time; resolve
    // it there so the root can be read from any invocation directory.
    const reached = new Set<string>()
    for (const input of Object.keys(metafile?.inputs ?? {})) {
      const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input)
      if (!relative(yrdRoot, absolute).startsWith("..")) continue
      const match = /(?:^|\/)(vendor\/[^/]+)\//u.exec(absolute)
      if (match !== null) reached.add(match[1] as string)
    }
    expect(
      reached.size,
      "the runtime's module graph reached NO vendor root, so this measurement, not the constant, is at fault",
    ).toBeGreaterThan(0)
    const declared = YRD_RUNTIME_COMPONENTS.filter((component) => component !== YRD_RUNTIME_OWN_COMPONENT)
    // Equality in BOTH directions: a reached root missing from the constant is
    // unwatched; a constant entry nothing reaches is a path the loop would wait
    // on for a move that can never load.
    expect([...reached].sort()).toEqual([...declared].sort())
  }, 60_000)
})
