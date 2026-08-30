/**
 * @failure  A commit takes a test file and leaves the source half it imports
 *           uncommitted in the working tree. The tree stays green — the
 *           working tree holds both halves — while the COMMIT does not build:
 *           an import of a missing named export fails at module load, so the
 *           affected test files cannot start at all. Nothing else catches it.
 *           Not typecheck and not the suite, both of which read the working
 *           tree; not review, because both halves are visible to the person
 *           looking. @i/10-yrd/23232-export-import-guard.
 * @level    l1 (one `git ls-tree` and one `git cat-file --batch`; no network,
 *           no TypeScript program, no module load)
 * @consumer @i/10-yrd/23232-export-import-guard
 *
 * MEASURED SPECIMEN — commit `053bd875` ("test(cli): re-home the remedy guard
 * on the real population; cover the mint rescue", 2026-08-28) committed tests
 * importing four symbols whose exports were left behind in the working tree:
 *
 *     yrd-cli  src/host.ts  ->  materializeCarrier
 *     yrd-cli  src/run.ts   ->  carriedBranchSet
 *     yrd-cli  src/run.ts   ->  yrdCommandSurface
 *     yrd-cli  src/run.ts   ->  YrdCommandFact
 *
 * It stayed broken for six commits. `materializeCarrier` was repaired
 * incidentally by an unrelated commit (`1ea662c7`, the mint rescue); the other
 * three needed `98824eed`. Nobody noticed in between, because the package
 * carried a large deliberate red budget during the branch-is-change cutover
 * and three import failures are invisible inside it. A RED BUDGET IS A PLACE
 * FOR A REAL REGRESSION TO HIDE — that is the general lesson, and it outlives
 * the specimen.
 *
 * WHY IT READS HEAD AND NOT THE WORKING TREE. Both halves are read through
 * `git cat-file --batch` at HEAD. That is the entire point: the question this
 * guard asks is "does the COMMIT build", and every instrument that reads the
 * working tree answers a different question. Reading one half from HEAD and
 * the other from disk would be worse than either — it would fire on the
 * ordinary mid-edit state of any developer who has added an export but not yet
 * committed it.
 *
 * DESIGNED HOME: written to
 * `packages/yrd-cli/tests/test-imports-exist-at-head-guard.test.ts` — colocated
 * with yrd-cli, which owns the specimen and 216 of the ~292 in-scope import
 * statements — but it sweeps EVERY package's tests, not just yrd-cli's, since
 * the defect class can recur anywhere. `import.meta.dirname` walks up 3 levels
 * (`tests/` -> `yrd-cli/` -> `packages/` -> repo root), so it is location-
 * sensitive to exactly that depth.
 *
 * FALSE POSITIVES ARE THE FAILURE MODE THAT MATTERS. The prototype written
 * during the incident reported eleven misses, every one of them false, purely
 * from unhandled re-export forms. A guard that cries wolf eleven times is
 * disabled within a day. So an export form this file cannot resolve is
 * reported as UNRESOLVED and never as an offender — see `unresolved` below and
 * the test that pins it.
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(import.meta.dirname, "../../../")

/* ------------------------------------------------------------------ *
 * Reading HEAD                                                        *
 * ------------------------------------------------------------------ */

/** Every path in the HEAD tree. One `git ls-tree`, so module resolution below
 * is a set lookup rather than a stat per candidate extension. */
function headPaths(repoRoot: string): ReadonlySet<string> {
  const listed = spawnSync("git", ["ls-tree", "-r", "HEAD", "--name-only"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (listed.status !== 0) {
    throw new Error(`git ls-tree -r HEAD failed: ${listed.stderr ?? ""}`)
  }
  return new Set(listed.stdout.split("\n").filter((line) => line.length > 0))
}

/**
 * The HEAD content of every requested path, in ONE `git cat-file --batch`
 * process. Measured 2026-08-30: 403 files / 8.2 MiB in ~40 ms, which is what
 * keeps the whole guard inside its budget — a `git show` per file would be
 * hundreds of process spawns.
 *
 * Sizes in the batch protocol are BYTE counts, so the response is parsed as a
 * Buffer and sliced by byte offset; decoding first would desynchronize the
 * stream on any non-ASCII source file. A path absent from HEAD (staged but not
 * yet committed) answers `missing` and is simply left out of the map — it is
 * not part of the commit, so it is not part of the question.
 */
function readBlobsAtHead(repoRoot: string, paths: readonly string[]): ReadonlyMap<string, string> {
  if (paths.length === 0) return new Map()
  const batch = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${paths.map((path) => `HEAD:${path}`).join("\n")}\n`,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (batch.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${String(batch.stderr ?? "")}`)
  }
  const out = batch.stdout
  const blobs = new Map<string, string>()
  let offset = 0
  for (const path of paths) {
    const newline = out.indexOf(0x0a, offset)
    if (newline === -1) throw new Error(`git cat-file --batch: response truncated at ${path}`)
    const header = out.toString("utf8", offset, newline)
    offset = newline + 1
    // `<request> missing` — the only non-`<oid> <type> <size>` shape.
    if (header.endsWith(" missing")) continue
    const size = Number(header.split(" ")[2])
    if (!Number.isFinite(size)) throw new Error(`git cat-file --batch: unparsable header '${header}'`)
    blobs.set(path, out.toString("utf8", offset, offset + size))
    offset += size + 1 // the newline git writes after each object
  }
  return blobs
}

/* ------------------------------------------------------------------ *
 * Paths                                                              *
 * ------------------------------------------------------------------ */

/** Join a git-style (always forward-slashed, always repo-relative) directory
 * with a relative specifier, resolving `.` and `..`. `node:path`'s `join`
 * would use the platform separator; git paths never do. */
function joinPosix(dir: string, specifier: string): string {
  const segments: string[] = []
  for (const segment of `${dir}/${specifier}`.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join("/")
}

function dirnamePosix(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? "" : path.slice(0, cut)
}

/** `packages/<pkg>` for a path inside one, else undefined. A test outside
 * `packages/` (the repo-root `tests/` tree) has no "own package" and is
 * therefore outside this guard's question. */
function packageRootOf(path: string): string | undefined {
  const segments = path.split("/")
  if (segments.length < 3 || segments[0] !== "packages") return undefined
  return `packages/${String(segments[1])}`
}

/** The module a relative specifier names, or undefined if HEAD has no such
 * file. Bare specifiers (`@yrd/core`, `vitest`) resolve to undefined by
 * design: this guard's question is scoped to a test's OWN package. */
function resolveRelative(fromPath: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const base = joinPosix(dirnamePosix(fromPath), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (known.has(candidate)) return candidate
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Imports                                                            *
 * ------------------------------------------------------------------ */

/**
 * Anchored at column 0 with the `m` flag: an ESM import statement is always
 * top-level, and the anchor is what keeps example code inside a JSDoc block or
 * a fixture template literal (both indented, in this tree) out of the scan.
 * The clause may not contain a quote or a semicolon, which lets it span the
 * newlines of a multi-line brace list without running past the statement. The
 * trailing `from "..."` requirement disambiguates a clause that itself binds
 * an identifier named `from`.
 */
const IMPORT_RE = /^import\s+(?:type\s+)?([^"';]*?)from\s*["']([^"']+)["']/gm

/** The names an import clause requires its module to export. `X as Y` requires
 * `X` — the local alias is this file's business, not the module's. A namespace
 * clause (`* as ns`) requires nothing. A default clause requires `default`. */
function importedNames(clause: string): readonly string[] {
  const names: string[] = []
  const brace = clause.indexOf("{")
  const head = (brace === -1 ? clause : clause.slice(0, brace)).trim().replace(/,$/u, "").trim()
  if (head.length > 0 && !head.startsWith("*")) names.push("default")
  if (brace !== -1) {
    const close = clause.indexOf("}", brace)
    for (const raw of clause.slice(brace + 1, close === -1 ? undefined : close).split(",")) {
      const entry = raw
        .trim()
        .replace(/^type\s+/u, "")
        .trim()
      if (entry.length === 0) continue
      // `X as Y` -> X. A type-only entry counts exactly like a value entry:
      // a missing type export is a build failure under verbatimModuleSyntax,
      // and the specimen's `YrdCommandFact` was precisely that shape.
      const name = entry.split(/\s+as\s+/u)[0]?.trim()
      if (name !== undefined && name.length > 0) names.push(name)
    }
  }
  return names
}

type ImportSite = Readonly<{ specifier: string; names: readonly string[]; line: number }>

function importSites(content: string): readonly ImportSite[] {
  const sites: ImportSite[] = []
  for (const match of content.matchAll(IMPORT_RE)) {
    const names = importedNames(match[1] ?? "")
    if (names.length === 0) continue
    sites.push({
      specifier: match[2] ?? "",
      names,
      line: content.slice(0, match.index).split("\n").length,
    })
  }
  return sites
}

/* ------------------------------------------------------------------ *
 * Exports                                                            *
 * ------------------------------------------------------------------ */

/** `export function|const|let|var|class|interface|enum|type|namespace NAME`,
 * with the `declare`/`async`/`abstract`/generator modifiers this tree uses.
 * `export default …` deliberately does NOT match: its exported name is
 * `default`, never the declaration's own identifier. */
const EXPORT_DECL_RE =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|const|let|var|class|interface|enum|type|namespace)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_DEFAULT_RE = /^export\s+default\b/gm
/** `export { … }` and `export { … } from "…"`, brace body spanning lines. */
const EXPORT_BRACE_RE = /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm
/** `export * from "…"` and `export * as ns from "…"`. */
const EXPORT_STAR_RE = /^export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*["']([^"']+)["']/gm

type Surface = Readonly<{
  /** Every name the module exports, as far as this file can prove. */
  names: ReadonlySet<string>
  /** Export forms whose contribution to `names` could not be determined —
   * today, only a bare-specifier `export * from "some-pkg"`, which makes the
   * surface open-ended. An import satisfied by one of these is reported as
   * unresolved, NEVER as an offender. */
  unresolved: readonly string[]
}>

/**
 * The export surface of `modulePath` at HEAD.
 *
 * `export * from "./local.ts"` is followed rather than skipped — every one of
 * the 53 in this tree is a relative barrel (each package's own `src/index.ts`),
 * and skipping them would blind the guard to the 13 test files that import
 * through a barrel. `seen` breaks the cycle a mutually-re-exporting pair would
 * create.
 */
function exportSurface(
  modulePath: string,
  blobs: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
  seen: Set<string> = new Set(),
): Surface {
  if (seen.has(modulePath)) return { names: new Set(), unresolved: [] }
  seen.add(modulePath)
  const content = blobs.get(modulePath)
  if (content === undefined) {
    return { names: new Set(), unresolved: [`${modulePath}: not readable at HEAD`] }
  }

  const names = new Set<string>()
  const unresolved: string[] = []

  for (const match of content.matchAll(EXPORT_DECL_RE)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  if (EXPORT_DEFAULT_RE.test(content)) names.add("default")
  EXPORT_DEFAULT_RE.lastIndex = 0

  for (const match of content.matchAll(EXPORT_BRACE_RE)) {
    // A braced re-export names its symbols explicitly, so it resolves whether
    // the source is relative or bare — `export type { PrNumberMint } from
    // "@yrd/persistence"` needs no lookup to know it exports PrNumberMint.
    for (const raw of (match[1] ?? "").split(",")) {
      const entry = raw
        .trim()
        .replace(/^type\s+/u, "")
        .trim()
      if (entry.length === 0) continue
      // `X as Y` exports Y — here the alias IS the exported name, the opposite
      // of the import side above.
      const parts = entry.split(/\s+as\s+/u)
      const exported = (parts[parts.length - 1] ?? "").trim()
      if (exported.length > 0) names.add(exported)
    }
  }

  for (const match of content.matchAll(EXPORT_STAR_RE)) {
    const alias = match[1]
    const specifier = match[2] ?? ""
    if (alias !== undefined) {
      names.add(alias)
      continue
    }
    const target = resolveRelative(modulePath, specifier, known)
    if (target === undefined) {
      unresolved.push(`${modulePath}: export * from "${specifier}" — surface not resolvable from HEAD`)
      continue
    }
    const inner = exportSurface(target, blobs, known, seen)
    for (const name of inner.names) names.add(name)
    unresolved.push(...inner.unresolved)
  }

  return { names, unresolved }
}

/* ------------------------------------------------------------------ *
 * The sweep                                                          *
 * ------------------------------------------------------------------ */

type Sweep = Readonly<{
  offenders: readonly string[]
  unresolved: readonly string[]
  importsChecked: number
  modulesChecked: number
}>

/**
 * For every test file, every symbol it imports from a module inside its OWN
 * package must be exported by that module at HEAD.
 *
 * Scope is the test's own package — the boundary a pathspec commit splits, and
 * the boundary the specimen crossed. Cross-package imports (`@yrd/core`) are
 * deliberately out of scope: they resolve through workspace metadata rather
 * than the filesystem, and a cross-package half-commit is a different defect
 * with a different cure.
 */
function sweep(testPaths: readonly string[], blobs: ReadonlyMap<string, string>, known: ReadonlySet<string>): Sweep {
  const offenders: string[] = []
  const unresolved: string[] = []
  const surfaces = new Map<string, Surface>()
  let importsChecked = 0

  for (const testPath of testPaths) {
    const content = blobs.get(testPath)
    if (content === undefined) continue // staged but not committed — not in this commit
    const packageRoot = packageRootOf(testPath)
    if (packageRoot === undefined) continue

    for (const site of importSites(content)) {
      const target = resolveRelative(testPath, site.specifier, known)
      if (target === undefined || !target.startsWith(`${packageRoot}/`)) continue

      let surface = surfaces.get(target)
      if (surface === undefined) {
        surface = exportSurface(target, blobs, known)
        surfaces.set(target, surface)
      }
      if (surface.unresolved.length > 0) {
        // Open-ended surface: this import can be neither proven nor faulted.
        // Report it, never fault it — a false offender is what gets a guard
        // switched off.
        unresolved.push(
          `${testPath}:${String(site.line)}: imports {${site.names.join(", ")}} from "${site.specifier}" — ` +
            `${surface.unresolved.join("; ")}`,
        )
        continue
      }
      importsChecked += site.names.length
      for (const name of site.names) {
        if (surface.names.has(name)) continue
        offenders.push(
          `${testPath}:${String(site.line)}: imports '${name}' from "${site.specifier}" (${target}) — not exported at HEAD`,
        )
      }
    }
  }

  return { offenders, unresolved, importsChecked, modulesChecked: surfaces.size }
}

/* ------------------------------------------------------------------ *
 * Live surface                                                       *
 * ------------------------------------------------------------------ */

const LIVE = (() => {
  const known = headPaths(REPO_ROOT)
  const sources = [...known].filter((path) => /^packages\/[^/]+\/.*\.tsx?$/u.test(path))
  const testPaths = sources.filter((path) => /\.test\.tsx?$/u.test(path))
  const blobs = readBlobsAtHead(REPO_ROOT, sources)
  return { known, testPaths, blobs, ...sweep(testPaths, blobs, known) }
})()

describe("every test's own-package imports are exported at HEAD", () => {
  it("sweeps the whole population, not a hand-picked subset", () => {
    // 2026-08-30 denominator: 251 test files under packages/ at HEAD, across
    // 11 packages. A drop below this floor without a deliberate edit here
    // means the walk broke, not that the tests vanished — the same silent-zero
    // failure this guard exists to prevent in the surface it watches.
    expect(LIVE.testPaths.length).toBeGreaterThanOrEqual(200)
    expect(LIVE.blobs.size).toBeGreaterThanOrEqual(300)
    // And it must actually have checked symbols: a sweep that resolved no
    // module would report zero offenders for the same reason a clean tree does.
    expect(LIVE.importsChecked).toBeGreaterThanOrEqual(200)
    expect(LIVE.modulesChecked).toBeGreaterThanOrEqual(30)
  })

  it("no test imports a symbol its own package does not export at HEAD", () => {
    expect(
      LIVE.offenders,
      `a committed test imports a symbol that HEAD does not export — the source half was left in the working ` +
        `tree (@i/10-yrd/23232-export-import-guard, specimen 053bd875):\n${LIVE.offenders.join("\n")}`,
    ).toEqual([])
  })

  it("reports every export form it could not resolve, rather than passing it silently", () => {
    // Empty today: all 53 `export * from` in this tree name a relative module,
    // which `exportSurface` follows. A bare-specifier `export * from "pkg"`
    // would make a surface open-ended, and every import through it would land
    // here instead of being wrongly faulted above. If this list grows, the
    // honest cures are to name the symbols (`export { a, b } from "pkg"`) or to
    // accept that those imports are unguarded — never to delete this test.
    expect(
      LIVE.unresolved,
      `import sites whose module surface could not be resolved from HEAD — these are UNGUARDED, not clean:\n` +
        LIVE.unresolved.join("\n"),
    ).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Pinned detector proof                                              *
 * ------------------------------------------------------------------ */

/**
 * The live scan above is green, and a green scan proves nothing about the
 * detector — a regex that matches nothing reports zero offenders for exactly
 * the same reason a healthy tree does. These fixtures are the positive
 * control, and they are not invented: they reproduce the import lines and the
 * export state of commit `053bd875` verbatim (verified 2026-08-30 with
 * `git show 053bd875:<path>`).
 *
 * They are held as literals rather than read from git history so the proof
 * survives a shallow clone, a rewritten history, or the eventual expiry of
 * that commit from any given checkout.
 */
const FIXTURE_HEAD: ReadonlyMap<string, string> = new Map([
  [
    // The real import line from 053bd875. Two of its three symbols WERE
    // exported — the fixture's job is to prove the detector faults exactly one.
    "packages/yrd-cli/tests/push-is-submit-resolver.test.ts",
    'import { materializeCarrier, receiverTarget, type ReceiverBayView } from "../src/host.ts"\n',
  ],
  ["packages/yrd-cli/tests/carried-branch-population.test.ts", 'import { carriedBranchSet } from "../src/run.ts"\n'],
  [
    "packages/yrd-cli/tests/remedy-executable-in-emitting-state.test.ts",
    'import { yrdCommandSurface, type YrdCommandFact } from "../src/run.ts"\n',
  ],
  [
    "packages/yrd-cli/tests/retired-verb-remedies-are-executable.test.ts",
    'import { runYrd, yrdCommandSurface } from "../src/run.ts"\n',
  ],
  [
    // host.ts at 053bd875: ReceiverBayView and receiverTarget present at lines
    // 2442/2455, materializeCarrier absent (it arrived with 1ea662c7).
    "packages/yrd-cli/src/host.ts",
    ["export type ReceiverBayView = Readonly<{", "  bay: string", "}>", "export function receiverTarget() {}", ""].join(
      "\n",
    ),
  ],
  [
    // run.ts at 053bd875: runYrd present at line 11866; carriedBranchSet,
    // yrdCommandSurface and YrdCommandFact absent (they arrived with 98824eed).
    "packages/yrd-cli/src/run.ts",
    ["export function runYrdHelp() {}", "export function runYrd() {}", ""].join("\n"),
  ],
])

const FIXTURE_KNOWN: ReadonlySet<string> = new Set(FIXTURE_HEAD.keys())

describe("detector: the pinned 053bd875 shape", () => {
  // Four distinct symbols, five import sites: `yrdCommandSurface` was imported
  // by two different test files, and each site is its own load failure.
  it("faults exactly the four symbols the incident shipped broken, at all five sites", () => {
    const result = sweep(
      [...FIXTURE_HEAD.keys()].filter((p) => p.endsWith(".test.ts")),
      FIXTURE_HEAD,
      FIXTURE_KNOWN,
    )
    expect(result.offenders).toEqual([
      `packages/yrd-cli/tests/push-is-submit-resolver.test.ts:1: imports 'materializeCarrier' from "../src/host.ts" (packages/yrd-cli/src/host.ts) — not exported at HEAD`,
      `packages/yrd-cli/tests/carried-branch-population.test.ts:1: imports 'carriedBranchSet' from "../src/run.ts" (packages/yrd-cli/src/run.ts) — not exported at HEAD`,
      `packages/yrd-cli/tests/remedy-executable-in-emitting-state.test.ts:1: imports 'yrdCommandSurface' from "../src/run.ts" (packages/yrd-cli/src/run.ts) — not exported at HEAD`,
      `packages/yrd-cli/tests/remedy-executable-in-emitting-state.test.ts:1: imports 'YrdCommandFact' from "../src/run.ts" (packages/yrd-cli/src/run.ts) — not exported at HEAD`,
      `packages/yrd-cli/tests/retired-verb-remedies-are-executable.test.ts:1: imports 'yrdCommandSurface' from "../src/run.ts" (packages/yrd-cli/src/run.ts) — not exported at HEAD`,
    ])
    expect(result.unresolved).toEqual([])
  })

  it("clears once the source halves are committed — the repair, not a weakened detector", () => {
    const repaired = new Map(FIXTURE_HEAD)
    repaired.set(
      "packages/yrd-cli/src/host.ts",
      `${String(FIXTURE_HEAD.get("packages/yrd-cli/src/host.ts"))}export async function materializeCarrier() {}\n`,
    )
    repaired.set(
      "packages/yrd-cli/src/run.ts",
      `${String(FIXTURE_HEAD.get("packages/yrd-cli/src/run.ts"))}export function carriedBranchSet() {}\n` +
        "export function yrdCommandSurface() {}\nexport type YrdCommandFact = Readonly<{ path: string }>\n",
    )
    const result = sweep(
      [...repaired.keys()].filter((p) => p.endsWith(".test.ts")),
      repaired,
      new Set(repaired.keys()),
    )
    expect(result.offenders).toEqual([])
    expect(result.importsChecked).toBe(8)
  })
})

describe("detector: the export forms that made the first prototype cry wolf", () => {
  /** Build a one-test/one-or-more-module fixture and sweep it. */
  function check(modules: Readonly<Record<string, string>>, importLine: string): Sweep {
    const blobs = new Map<string, string>(Object.entries(modules))
    blobs.set("packages/p/tests/t.test.ts", `${importLine}\n`)
    return sweep(["packages/p/tests/t.test.ts"], blobs, new Set(blobs.keys()))
  }

  it("resolves a multi-line braced export list", () => {
    const module = ["const a = 1", "const b = 2", "export {", "  a,", "  type b,", "}", ""].join("\n")
    expect(check({ "packages/p/src/m.ts": module }, 'import { a, type b } from "../src/m.ts"').offenders).toEqual([])
  })

  it("resolves a braced re-export from a relative module", () => {
    expect(
      check(
        { "packages/p/src/m.ts": 'export { alpha, type Beta } from "./inner.ts"\n', "packages/p/src/inner.ts": "" },
        'import { alpha, type Beta } from "../src/m.ts"',
      ).offenders,
    ).toEqual([])
  })

  it("resolves a braced re-export from a BARE specifier without following it", () => {
    // `export type { PrNumberMint } from "@yrd/persistence"` — the names are
    // explicit, so the surface is known even though the module is not ours.
    expect(
      check(
        { "packages/p/src/m.ts": 'export type { PrNumberMint } from "@yrd/persistence"\n' },
        'import type { PrNumberMint } from "../src/m.ts"',
      ).offenders,
    ).toEqual([])
  })

  it("follows `export * from` through a relative barrel, one hop and two", () => {
    const result = check(
      {
        "packages/p/src/index.ts": 'export * from "./mid.ts"\n',
        "packages/p/src/mid.ts": 'export * from "./leaf.ts"\n',
        "packages/p/src/leaf.ts": "export const deep = 1\n",
      },
      'import { deep } from "../src/index.ts"',
    )
    expect(result.offenders).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it("still faults a name no barrel hop provides", () => {
    expect(
      check(
        {
          "packages/p/src/index.ts": 'export * from "./leaf.ts"\n',
          "packages/p/src/leaf.ts": "export const deep = 1\n",
        },
        'import { absent } from "../src/index.ts"',
      ).offenders,
    ).toEqual([
      `packages/p/tests/t.test.ts:1: imports 'absent' from "../src/index.ts" (packages/p/src/index.ts) — not exported at HEAD`,
    ])
  })

  it("reports — never faults — an import through a bare-specifier `export *`", () => {
    const result = check(
      { "packages/p/src/m.ts": 'export * from "some-external-pkg"\n' },
      'import { whoKnows } from "../src/m.ts"',
    )
    expect(result.offenders).toEqual([])
    expect(result.unresolved).toEqual([
      `packages/p/tests/t.test.ts:1: imports {whoKnows} from "../src/m.ts" — ` +
        `packages/p/src/m.ts: export * from "some-external-pkg" — surface not resolvable from HEAD`,
    ])
  })

  it("survives a re-export cycle instead of recursing forever", () => {
    const result = check(
      {
        "packages/p/src/a.ts": 'export * from "./b.ts"\nexport const fromA = 1\n',
        "packages/p/src/b.ts": 'export * from "./a.ts"\nexport const fromB = 2\n',
      },
      'import { fromA, fromB } from "../src/a.ts"',
    )
    expect(result.offenders).toEqual([])
  })

  it("requires the ORIGINAL name for `X as Y` on the import side, and the ALIAS on the export side", () => {
    // import: `materialize as make` needs the module to export `materialize`.
    expect(
      check(
        { "packages/p/src/m.ts": "export function materialize() {}\n" },
        'import { materialize as make } from "../src/m.ts"',
      ).offenders,
    ).toEqual([])
    // export: `internal as public` puts `public` on the surface, not `internal`.
    expect(
      check(
        { "packages/p/src/m.ts": "const internal = 1\nexport { internal as publicName }\n" },
        'import { publicName } from "../src/m.ts"',
      ).offenders,
    ).toEqual([])
    expect(
      check(
        { "packages/p/src/m.ts": "const internal = 1\nexport { internal as publicName }\n" },
        'import { internal } from "../src/m.ts"',
      ).offenders,
    ).toEqual([
      `packages/p/tests/t.test.ts:1: imports 'internal' from "../src/m.ts" (packages/p/src/m.ts) — not exported at HEAD`,
    ])
  })

  it("checks nothing for a namespace import, and `default` for a default import", () => {
    expect(check({ "packages/p/src/m.ts": "" }, 'import * as everything from "../src/m.ts"').offenders).toEqual([])
    expect(check({ "packages/p/src/m.ts": "" }, 'import whatever from "../src/m.ts"').offenders).toEqual([
      `packages/p/tests/t.test.ts:1: imports 'default' from "../src/m.ts" (packages/p/src/m.ts) — not exported at HEAD`,
    ])
    expect(
      check({ "packages/p/src/m.ts": "export default function anyName() {}\n" }, 'import whatever from "../src/m.ts"')
        .offenders,
    ).toEqual([])
  })

  it("resolves every declaration modifier this tree uses", () => {
    const module = [
      "export async function asyncFn() {}",
      "export function* genFn() {}",
      "export const konst = 1",
      "export let mutable = 2",
      "export class Klass {}",
      "export abstract class Abstract {}",
      "export interface Iface { a: 1 }",
      "export enum Enum { A }",
      "export type Alias = string",
      "export declare const declared: number",
      "",
    ].join("\n")
    const names = "asyncFn, genFn, konst, mutable, Klass, Abstract, type Iface, Enum, type Alias, declared"
    expect(check({ "packages/p/src/m.ts": module }, `import { ${names} } from "../src/m.ts"`).offenders).toEqual([])
  })

  it("ignores a cross-package import and a bare specifier entirely", () => {
    const blobs = new Map<string, string>([
      ["packages/other/src/m.ts", ""],
      [
        "packages/p/tests/t.test.ts",
        'import { thing } from "../../other/src/m.ts"\nimport { another } from "vitest"\n',
      ],
    ])
    const result = sweep(["packages/p/tests/t.test.ts"], blobs, new Set(blobs.keys()))
    expect(result.offenders).toEqual([])
    expect(result.importsChecked).toBe(0)
  })

  it("skips a test file that is not in the commit", () => {
    // Staged-but-uncommitted: `git cat-file` answered `missing`, so it is
    // absent from the blob map. It is not part of this commit, so it is not
    // part of the question — and it must not throw.
    const result = sweep(["packages/p/tests/ghost.test.ts"], new Map(), new Set())
    expect(result.offenders).toEqual([])
  })
})
