/**
 * @failure  A warn/error log record ships with no structured identity, or with
 *           an identity another site already claims. 148 of the 17,739
 *           warn+error records the resident runner wrote between 2026-08-20
 *           and 2026-08-31 carried no `action` field at all, so no operator
 *           could count a condition, and one key (`compose-candidate-skip`)
 *           stood for twelve unrelated call sites, so counting it answered
 *           nothing. Neither defect is visible in review: the line reads fine.
 * @level    l1 (pure static scan of this repo's own checked-out source; no
 *           subprocess, no network, no clock)
 * @consumer @yrd/core log-action catalogs
 *
 * WHAT THIS GUARDS, in one sentence each:
 *   1. every warn/error emission site carries an `action`;
 *   2. no two sites claim the same action key;
 *   3. every catalog entry is actually emitted (a definition with no site is
 *      the registry rot this design exists to avoid);
 *   4. a site's emitting method matches the level its catalog entry declares —
 *      the STRICT invariant `no-parallel-derivation` asks for wherever a fact
 *      is not literally shared;
 *   5. the count of sites still spelling their action as a bare string only
 *      ever goes DOWN.
 *
 * (5) is a high-water NUMBER, not an allowlist, and that is deliberate: an
 * allowlist is a second list to maintain and would reintroduce exactly the
 * drift this file exists to stop. New code cannot raise it; a migration lowers
 * it; nobody edits a table.
 *
 * SCOPE. This scans `packages/<pkg>/src/**` of this repository only.
 * `import.meta.dirname` walks up three levels (`tests/` -> `yrd-core/` ->
 * `packages/` -> repo root), so the file is location-sensitive to that depth.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { LOG_ACTION_KEY_PATTERN } from "../src/log-action.ts"

const PACKAGES_ROOT = resolve(import.meta.dirname, "../../")

/**
 * How many warn/error sites still write `action: "some-string"` instead of
 * referencing a catalog entry. Lower this when you migrate sites; the guard
 * refuses any increase. It must never be raised.
 */
const STRING_LITERAL_ACTION_HIGH_WATER = 57

/**
 * Warn/error sites that still construct their own props and carry no action.
 * All of them live in `yrd-cli/src/host.ts` and `run.ts`, which carried
 * another seat's uncommitted rewrites when this census was taken; keying them
 * is a one-line edit each once those land. Same ratchet as the literal count
 * above and for the same reason: a number nobody edits beats a list somebody
 * curates.
 */
const UNKEYED_SITE_HIGH_WATER = 5

/* Measured 2026-08-31 against a tree where `host.ts` and `run.ts` carried
 * another seat's uncommitted rewrites, so the five are a moving baseline until
 * those land. That is safe in this direction: a high-water only fails on an
 * INCREASE, so a peer keying one of them keeps this green while a new unkeyed
 * site turns it red. */

/** Sites that CANNOT carry a structured action because they do not reach a
 * logger at all: they write a stream or call an injected string-only sink, so
 * there is no props object for a key to live in. Naming them here is not a
 * pardon — each is a real gap whose fix is to put the site on the logger, at
 * which point it leaves this list and gains a key like every other site. */
const UNSTRUCTURED_SINKS: readonly Readonly<{ file: string; reason: string }>[] = [
  {
    file: "yrd-bay/src/receiver.ts",
    reason: "console.error: the receiver's self-heal notice runs before a logger exists",
  },
  {
    file: "yrd-queue/src/command.ts",
    reason: "console.warn: the root-merge-fact notice writes the process stream directly",
  },
  { file: "yrd-cli/src/settlement.ts", reason: "launch.warn(string): an injected sink that takes prose and no props" },
]

function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path)
    }
  }
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    const src = join(PACKAGES_ROOT, pkg, "src")
    try {
      if (statSync(src).isDirectory()) walk(src)
    } catch {
      // A package with no src/ is not a finding; the census covers what exists.
    }
  }
  // A census over zero files would pass every assertion below silently.
  if (found.length === 0) throw new Error(`yrd: log-action census found no source under ${PACKAGES_ROOT}`)
  return found
}

/** Index of the `)` closing the `(` at `open`, skipping strings, template
 * literals and comments so a paren inside prose cannot end the call early. */
function closingParen(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      i++
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1
      i++
      continue
    }
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

type Site = Readonly<{
  file: string
  line: number
  /** The method actually called: the level the record ships at. */
  level: "warn" | "error"
  /** Catalog const name when the site references one, else undefined. */
  reference: string | undefined
  /** Literal string when the site spells its own action, else undefined. */
  literal: string | undefined
  /** True when the call carries an `action` in some form (including one
   * reached through a local props variable). */
  keyed: boolean
  /** True when the call forwards a props value it did not build — a parameter
   * or a field off another object. A relay cannot own an identity: whatever
   * constructed those props does, and that producer is a site of its own. */
  relay: boolean
}>

/** The last top-level argument of a call written as `name(a, b, c)`, or
 * undefined when it takes none. Only paren/brace/bracket depth and string
 * boundaries matter here, so this needs no parser. */
function lastArgument(call: string): string | undefined {
  const open = call.indexOf("(")
  const inner = call.slice(open + 1, call.lastIndexOf(")"))
  let depth = 0
  let start = 0
  const args: string[] = []
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      i++
      while (i < inner.length && inner[i] !== quote) i += inner[i] === "\\" ? 2 : 1
      continue
    }
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") depth--
    else if (c === "," && depth === 0) {
      args.push(inner.slice(start, i))
      start = i + 1
    }
  }
  args.push(inner.slice(start))
  const trimmed = args.map((a) => a.trim()).filter((a) => a !== "")
  return trimmed.at(-1)
}

/** `action:` written as a catalog reference, a literal, or something else. */
const ACTION_REFERENCE = /\baction:\s*([A-Z][A-Z0-9_]*)\.key\b/
const ACTION_LITERAL = /\baction:\s*"([^"]+)"/
const ACTION_ANY = /\baction:/

function scanSites(files: readonly string[]): readonly Site[] {
  const sites: Site[] = []
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const relative = file.slice(PACKAGES_ROOT.length + 1)
    // Props hoisted into a local and passed by name are still keyed; the
    // identity lives at the producer, which this same scan sees.
    const hoisted = new Set(
      [...text.matchAll(/const\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*\{[^}]*\baction:/g)].map((m) => m[1] as string),
    )
    const record = (start: number, source: string, level: "warn" | "error"): void => {
      const referenced = ACTION_REFERENCE.exec(source)
      const literal = ACTION_LITERAL.exec(source)
      // A props object can reach the call by NAME or by SPREAD. Missing the
      // spread form is not a small error: `queue.ts` builds one `population`
      // object carrying the action and spreads it into both arms of an
      // if/else, so a scan blind to `...name` calls two keyed sites unkeyed
      // and invites a "fix" that overwrites the key that was already there.
      const viaLocal = [...hoisted].some((name) =>
        new RegExp(`(,\\s*${name}\\s*[,)])|(\\.\\.\\.${name}\\b)`).test(source),
      )
      const last = lastArgument(source)
      sites.push({
        file: relative,
        line: text.slice(0, start).split("\n").length,
        level,
        reference: referenced?.[1],
        literal: literal?.[1],
        keyed: ACTION_ANY.test(source) || viaLocal,
        // One argument means no props at all — a gap, not a relay. Two or more
        // with a non-literal tail means the props came from elsewhere.
        relay: last !== undefined && !last.startsWith("{") && (source.match(/,/) ?? []).length > 0 && last !== source,
      })
    }
    for (const level of ["warn", "error"] as const) {
      const call = new RegExp(`\\.${level}\\?\\.\\(|\\.${level}\\(`, "g")
      let match: RegExpExecArray | null
      while ((match = call.exec(text)) !== null) {
        const open = text.indexOf("(", match.index)
        const close = closingParen(text, open)
        if (close < 0) continue
        record(match.index, text.slice(match.index, close + 1), level)
      }
    }
    // `ConditionReporter.report(key, level, message, props)` is a warn/error
    // emission site too — a guard blind to it would call every deduped
    // condition unkeyed, which is 16 of them.
    const reports = /\.report\(/g
    let reported: RegExpExecArray | null
    while ((reported = reports.exec(text)) !== null) {
      const open = text.indexOf("(", reported.index)
      const close = closingParen(text, open)
      if (close < 0) continue
      const source = text.slice(reported.index, close + 1)
      const level = /,\s*"(warn|error)"\s*,/.exec(source)?.[1]
      if (level === undefined) continue
      record(reported.index, source, level as "warn" | "error")
    }
  }
  return sites
}

type Entry = Readonly<{ constName: string; key: string; level: string; file: string }>

/** Every `logAction({...})` definition in every package catalog. */
function scanCatalog(files: readonly string[]): readonly Entry[] {
  const entries: Entry[] = []
  for (const file of files.filter((f) => f.endsWith("/log-actions.ts"))) {
    const text = readFileSync(file, "utf8")
    const definition = /export const ([A-Z][A-Z0-9_]*) = logAction\(\{\s*key:\s*"([^"]+)",\s*level:\s*"(warn|error)",/g
    for (const m of text.matchAll(definition)) {
      entries.push({
        constName: m[1] as string,
        key: m[2] as string,
        level: m[3] as string,
        file: file.slice(PACKAGES_ROOT.length + 1),
      })
    }
  }
  return entries
}

const FILES = sourceFiles()
const SITES = scanSites(FILES)
const CATALOG = scanCatalog(FILES)

describe("log action census", () => {
  it("scans a live population, so a passing assertion below means something", () => {
    expect(FILES.length).toBeGreaterThan(50)
    expect(SITES.length).toBeGreaterThan(50)
    expect(CATALOG.length).toBeGreaterThan(0)
  })

  it("gives every warn/error emission site a structured action key", () => {
    const unstructured = new Set(UNSTRUCTURED_SINKS.map((s) => s.file))
    const missing = SITES.filter((s) => !s.keyed && !s.relay && !unstructured.has(s.file))
      .map((s) => `${s.file}:${s.line} .${s.level}`)
      .sort()
    expect(missing.length, `warn/error sites with no action key:\n${missing.join("\n")}`).toBeLessThanOrEqual(
      UNKEYED_SITE_HIGH_WATER,
    )
  })

  it("attributes a relayed record to the producer that built its props, not the forwarding call", () => {
    // A relay is excluded from the census by SHAPE, never by name: it passes
    // on a props value it did not construct. Proving relays exist keeps that
    // exclusion honest — a scan that silently classified everything as a relay
    // would pass the assertion above while checking nothing.
    const relays = SITES.filter((s) => s.relay)
    expect(relays.length).toBeGreaterThan(0)
    expect(relays.length).toBeLessThan(SITES.length / 2)
  })

  it("never lets two sites claim the same action key", () => {
    const claims = new Map<string, string[]>()
    for (const site of SITES) {
      const key = site.reference ?? site.literal
      if (key === undefined) continue
      claims.set(key, [...(claims.get(key) ?? []), `${site.file}:${site.line}`])
    }
    const shared = [...claims].filter(([, at]) => at.length > 1).map(([key, at]) => `${key} @ ${at.join(", ")}`)
    // `compose-candidate-skip` is the standing violation: twelve distinct
    // compose conditions behind one name, which is why counting it answers
    // nothing. It is listed by key so splitting it removes a line here rather
    // than editing a rule.
    expect(shared).toEqual([`compose-candidate-skip @ ${(claims.get("compose-candidate-skip") ?? []).join(", ")}`])
  })

  it("holds every catalog key to the naming convention", () => {
    const malformed = CATALOG.filter((e) => !LOG_ACTION_KEY_PATTERN.test(e.key)).map((e) => `${e.file}: ${e.key}`)
    expect(malformed).toEqual([])
  })

  it("names each entry's const after its key, so grepping either finds the other", () => {
    const mismatched = CATALOG.filter((e) => e.constName !== e.key.toUpperCase().replaceAll("-", "_")).map(
      (e) => `${e.file}: ${e.constName} defines '${e.key}'`,
    )
    expect(mismatched).toEqual([])
  })

  it("refuses a catalog entry no site emits", () => {
    const referenced = new Set(SITES.map((s) => s.reference).filter((r) => r !== undefined))
    const orphaned = CATALOG.filter((e) => !referenced.has(e.constName)).map((e) => `${e.file}: ${e.constName}`)
    expect(orphaned).toEqual([])
  })

  it("keeps a site's emitting method equal to the level its entry declares", () => {
    const byConst = new Map(CATALOG.map((e) => [e.constName, e]))
    const skewed = SITES.filter((s) => s.reference !== undefined)
      .map((s) => ({ site: s, entry: byConst.get(s.reference as string) }))
      .filter(({ site, entry }) => entry !== undefined && entry.level !== site.level)
      .map(
        ({ site, entry }) =>
          `${site.file}:${site.line} emits .${site.level}, ${entry?.constName} declares ${entry?.level}`,
      )
    expect(skewed).toEqual([])
  })

  it("only ever shrinks the number of sites spelling their own action string", () => {
    const literals = SITES.filter((s) => s.literal !== undefined).length
    expect(literals).toBeLessThanOrEqual(STRING_LITERAL_ACTION_HIGH_WATER)
  })
})
