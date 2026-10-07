/**
 * @reach bundle <a Bun.build metafile over the real CLI entry, resolved against this checkout>
 * @reach fs-walk vendor/yrd/packages/*\/src/**
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
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
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

/** The superproject that records this yrd checkout, or "" when it is a standalone/packaged install. */
function superprojectRoot(): string {
  return execFileSync("git", ["-C", yrdRoot, "rev-parse", "--show-superproject-working-tree"], {
    encoding: "utf8",
  }).trim()
}

/**
 * EVERY root gitlink path the superproject records, not only `vendor/*` (27886, @cto ruling 3(a), correction 4).
 * `ag` and `km` are root gitlinks too, so an import into either is a component the runtime loads in process;
 * matching `vendor/[^/]+` alone would pass it unwatched. `-r` is required because `vendor` is a plain tree, so a
 * non-recursive listing never reaches `vendor/yrd` and its siblings; git does not descend INTO a gitlink, so the
 * result is exactly the root gitlink set.
 */
function recordedRootGitlinks(root: string): string[] {
  const listing = execFileSync("git", ["-C", root, "ls-tree", "-r", "-z", "HEAD"], { encoding: "utf8" })
  const paths: string[] = []
  for (const row of listing.split("\0")) {
    const [meta, path] = row.split("\t")
    const [mode] = (meta ?? "").split(" ")
    if (mode === "160000" && path !== undefined) paths.push(path)
  }
  return paths
}

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
    // CORRECTION 4 (@cto 27886 ruling 3(a)): map each reached input to the ROOT GITLINK it lives under, from the
    // same ls-tree the superproject is read with — never a `vendor/*` regex, which cannot see an `ag` or `km` import.
    const root = superprojectRoot()
    const gitlinks = recordedRootGitlinks(root)
    // A metafile input path is relative to the process cwd at build time; resolve
    // it there so the root can be read from any invocation directory.
    const reached = new Set<string>()
    for (const input of Object.keys(metafile?.inputs ?? {})) {
      const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input)
      // The DEEPEST gitlink the input is under, so a nested path maps to its own gitlink and never to a parent.
      const owner = gitlinks
        .filter((component) => absolute.startsWith(`${join(root, component)}${sep}`))
        .sort((left, right) => right.length - left.length)[0]
      if (owner !== undefined) reached.add(owner)
    }
    expect(
      reached.size,
      "the runtime's module graph reached NO root gitlink, so this measurement, not the constant, is at fault",
    ).toBeGreaterThan(0)
    // Equality in BOTH directions: a reached root missing from the constant is
    // unwatched; a constant entry nothing reaches is a path the loop would wait
    // on for a move that can never load. The runtime's OWN gitlink is in both: its
    // own modules are reached inputs, and a `vendor/yrd` move must arm the exit.
    expect([...reached].sort()).toEqual([...YRD_RUNTIME_COMPONENTS].sort())
    expect(reached.has(YRD_RUNTIME_OWN_COMPONENT), "the runtime's own gitlink was not reached").toBe(true)
  }, 60_000)
})
