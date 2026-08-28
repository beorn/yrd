/**
 * @failure A refusal, remedy or help example prints a `yrd …` command the CLI
 * refuses — a retired verb, a retired flag, or a flag the named command does
 * not have. Naming a command that refuses is the same defect as naming none,
 * and it costs the operator at the exact moment they are already blocked.
 * @level l1 (static scan of this repo's own `packages/*​/src`, checked against
 * the live Commander tree; no network, one program construction)
 * @consumer @yrd/cli refusals, remedies and help examples
 *
 * THIS FILE USED TO BE THE DEFECT IT NAMES. Its two live-guard cross-checks
 * were deleted with the guards themselves (S7 branch-is-change, @i/10 22991),
 * leaving a walk of a hardcoded table against itself — the population it was
 * computed over was gone, so it could not fail. Worse, it then PINNED a broken
 * cure: `expect(remedy.text).toContain("yrd pr publish PR7")`, a verb retired
 * with the record store. The file whose whole purpose is "a refusal must not
 * print a command that refuses" was holding one in place.
 *
 * The population is now the real one: every `yrd …` citation in every package's
 * `src/`, checked against `yrdCommandSurface()` — the live Commander tree, with
 * `hidden` (how every retired verb is registered) read straight off it. Run
 * against the tree as it stood on 2026-08-27 this test fails on three shipped
 * defects at once:
 *   - `yrd cancel`'s description naming `yrd mr close --burn-payload`, whose
 *     own refusal named `yrd cancel` back — a two-command circle;
 *   - three refusal texts and two help examples naming `yrd pr create`, which
 *     always refused `record-mint-retired`;
 *   - the `bay handoff` remedy's two-step cure, `bay open --pr` then
 *     `pr create`, in which BOTH steps refuse.
 * The positive controls at the bottom keep exactly those specimens, so the
 * validator's ability to fail is proven and not assumed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { canonicalizeYrdCommandAliases } from "../src/invocation.ts"
import { yrdCommandSurface, type YrdCommandFact } from "../src/run.ts"

const PACKAGES_ROOT = resolve(import.meta.dirname, "../../../", "packages")

/** One `yrd …` command found in the source, with where it came from. */
type Citation = Readonly<{
  /** Words after `yrd`, before the first non-word token. */
  words: readonly string[]
  /** Long flags the citation names. */
  flags: readonly string[]
  /** A copy-paste command LINE (indented inside a template literal) rather than
   * an inline mention. A line is unambiguously a command, so it must resolve;
   * an inline mention may trail into prose, which resolution tolerates. */
  pasteable: boolean
  file: string
  text: string
}>

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/**
 * Every string and template literal in one TypeScript source, with comments
 * dropped.
 *
 * A regex sweep of the raw file cannot do this: comments in this codebase quote
 * commands constantly ("`yrd pr review` is retired"), and documenting a
 * retirement is not printing a cure. Only text the program can actually EMIT
 * counts, so the scanner tracks literal state properly instead of guessing.
 */
function stringLiterals(source: string): readonly string[] {
  const literals: string[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index)
      if (index === -1) break
      continue
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (char !== "'" && char !== '"' && char !== "`") {
      index += 1
      continue
    }
    const quote = char
    let cursor = index + 1
    let body = ""
    while (cursor < source.length) {
      const inner = source[cursor]
      if (inner === "\\") {
        cursor += 2
        continue
      }
      if (inner === quote) break
      // A non-template literal cannot span a newline; an unterminated one means
      // the scanner mis-read a regex or a division, so bail rather than swallow
      // the rest of the file.
      if (inner === "\n" && quote !== "`") break
      body += inner
      cursor += 1
    }
    if (source[cursor] === quote) literals.push(body)
    index = cursor + 1
  }
  return literals
}

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/u
/** `yrd …` anywhere in a literal, and `$ ${name} …` — the shape every help
 * example in `addExamples` / `addAuthoredCarrierWorkflow` takes, where `name`
 * is the CLI's own binary name. Other interpolated prefixes (`${bay}`,
 * `${repository}`) expand to more than the binary name and are left alone. */
const INLINE = /(?:\byrd|\$ \$\{name\})((?: +[^\s'"`]+)+)/gu

function citationsIn(literal: string, file: string): readonly Citation[] {
  const found: Citation[] = []
  for (const line of literal.split("\n")) {
    // A pasteable command line: indentation, then the command, then nothing but
    // its own arguments. This is the form an operator copies.
    const pasteable = /^\s+yrd\s/u.test(line)
    for (const match of line.matchAll(INLINE)) {
      const tail = match[1] ?? ""
      const words: string[] = []
      for (const token of tail.trim().split(/\s+/u)) {
        if (!COMMAND_WORD.test(token)) break
        words.push(token)
      }
      const flags = [...tail.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/gu)].map((flag) => flag[0])
      if (words.length === 0 && flags.length === 0) continue
      found.push({ words, flags, pasteable, file, text: `yrd${tail}`.trim() })
    }
  }
  return found
}

function sourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") sourceFiles(path, out)
      continue
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
    if (entry.includes(".test.")) continue
    out.push(path)
  }
}

/** Every package's `src/`, never a hand-picked subset: cures are printed from
 * `@yrd/bay`, `@yrd/queue` and `@yrd/contest` as well as the CLI. */
function surfaceSources(): readonly string[] {
  const files: string[] = []
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    const src = join(PACKAGES_ROOT, pkg, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    sourceFiles(src, files)
  }
  // A sweep that silently scanned nothing would pass every check below while
  // proving nothing — the exact failure class this guard exists to catch.
  if (files.length === 0) throw new Error("remedy-executable: enumerated no source files under packages/*/src")
  return files
}

function allCitations(): readonly Citation[] {
  const found: Citation[] = []
  for (const file of surfaceSources()) {
    const relative = file.slice(PACKAGES_ROOT.length + 1)
    for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
      found.push(...citationsIn(literal, relative))
    }
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Resolution against the live tree
 * ------------------------------------------------------------------ */

type Resolution = Readonly<{ kind: "none" }> | Readonly<{ kind: "command"; fact: YrdCommandFact; path: string }>

/**
 * The longest prefix of a citation's words that the CLI really registers, after
 * the invocation normalizer has had its say (`yrd queue ls` and `yrd watch` are
 * argv-level aliases, rewritten before Commander ever sees them).
 *
 * Longest-KNOWN-prefix, not longest-token-run: `yrd doctor found 3 orphans` is
 * prose after a real verb and resolves to `doctor`, while `yrd pr create` walks
 * one word further because `create` is a registered child — retired, and that is
 * exactly the finding.
 */
function resolveCitation(surface: ReadonlyMap<string, YrdCommandFact>, words: readonly string[]): Resolution {
  const canonical = canonicalizeYrdCommandAliases(words).filter((word) => COMMAND_WORD.test(word))
  let best: Readonly<{ fact: YrdCommandFact; path: string }> | undefined
  const walked: string[] = []
  for (const word of canonical) {
    walked.push(word)
    const path = walked.join(" ")
    const fact = surface.get(path)
    if (fact === undefined) break
    best = { fact, path }
  }
  return best === undefined ? { kind: "none" } : { kind: "command", ...best }
}

/** Every way one citation contradicts the live surface, in the operator's own
 * terms. Empty means the printed command runs as printed. */
function offences(surface: ReadonlyMap<string, YrdCommandFact>, citation: Citation): readonly string[] {
  const resolved = resolveCitation(surface, citation.words)
  if (resolved.kind === "none") {
    // An inline mention that resolves to no command is prose ("yrd sorts
    // identifiers…") or an opaque payload, not a prescription. A pasteable
    // command LINE has no such excuse.
    return citation.pasteable ? [`names no command at all (\`${citation.text}\`)`] : []
  }
  const problems: string[] = []
  if (!resolved.fact.live) {
    problems.push(`names 'yrd ${resolved.path}', which is registered hidden — a retired verb that only refuses`)
  }
  for (const flag of citation.flags) {
    const live = resolved.fact.options.get(flag)
    if (live === undefined) {
      problems.push(`names '${flag}', which 'yrd ${resolved.path}' does not declare`)
    } else if (!live) {
      problems.push(`names '${flag}', which 'yrd ${resolved.path}' declares as retired`)
    }
  }
  return problems.map((problem) => `${citation.file}: ${problem}`)
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

function liveSurface(): ReadonlyMap<string, YrdCommandFact> {
  const facts = yrdCommandSurface()
  // Two controls in one: the tree was really walked (a construction failure
  // would yield an empty surface that passes everything), and it was walked
  // deeply enough to reach a nested verb.
  expect(facts.length, "the live Commander tree must yield a populated surface").toBeGreaterThan(50)
  const surface = new Map(facts.map((fact) => [fact.path, fact] as const))
  expect(surface.get("pr submit")?.live, "control: `pr submit` is a live verb").toBe(true)
  return surface
}

describe("every yrd command a refusal, remedy or help example prints is one the CLI runs", () => {
  it("scans every package's src/, not a hand-picked subset", () => {
    const packages = new Set(surfaceSources().map((file) => file.slice(PACKAGES_ROOT.length + 1).split("/")[0]))
    // 2026-08-27 denominator: 10 packages carry a src/ dir. A drop below this
    // without a deliberate edit here means the walk broke.
    expect(packages.size).toBeGreaterThanOrEqual(10)
  })

  it("finds a real population of printed commands", () => {
    const citations = allCitations()
    // Measured 2026-08-27: 180+ citations across the packages. A collapse to a
    // handful means the extractor broke, and a broken extractor is a green test
    // that checks nothing — the exact way this file failed before.
    expect(citations.length).toBeGreaterThan(60)
    // The pasteable branch is exercised against a fixture, not the live source.
    // No src file carries an indented `  yrd …` block any more, and that is
    // deliberate: the actionable-error layer lifts a QUOTED `'yrd …'` into a
    // `resolve:` line and flattens everything around it, so an indented block
    // renders as one run-together sentence and never reaches the field an
    // operator reads. The rule stays because a future block would still have to
    // resolve; asserting the live source contains one would pin the shape the
    // renderer eats.
    const [pasteable] = citationsIn("Open it first:\n  yrd bay open --bay <name>\n", "fixture")
    expect(pasteable?.pasteable).toBe(true)
  })

  it("names no retired verb, no retired flag, and no flag its command lacks", () => {
    const surface = liveSurface()
    const offenders = allCitations().flatMap((citation) => offences(surface, citation))
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it("positive control: the two-command circle between `cancel` and `mr close`", () => {
    // `yrd cancel`'s own description, verbatim, as it shipped until 2026-08-27.
    // Its cure named `mr close`, whose refusal named `yrd cancel` back.
    const surface = liveSurface()
    const shipped =
      "stop the current attempt for a change or run — members re-queue and the change stays open; to stop " +
      "delivering it, use `yrd mr close --reason <text> --burn-payload` (run both for both effects)"
    const found = citationsIn(shipped, "control").flatMap((citation) => offences(surface, citation))
    expect(found.join("\n")).toContain("registered hidden")
  })

  it("positive control: a cure naming `yrd pr create`, which always refused", () => {
    const surface = liveSurface()
    const shipped = "if no PR exists for 'task/x' yet, run 'yrd pr create' from the pushed branch"
    expect(
      citationsIn(shipped, "control")
        .flatMap((citation) => offences(surface, citation))
        .join("\n"),
    ).toContain("registered hidden")
  })

  it("positive control: the handoff cure whose BOTH steps refuse", () => {
    const surface = liveSurface()
    // The remedy as it shipped: step one names a retired flag, step two a
    // retired verb. Same function, same defect, twice
    // (@i/16-work/23055-handoff-lies flavour 2).
    const shipped = "Open one from the packet's PR first:\n  yrd bay open --pr task/x\n  yrd pr create task/x\n"
    const found = citationsIn(shipped, "control").flatMap((citation) => offences(surface, citation))
    expect(found.join("\n")).toContain("declares as retired")
    expect(found.join("\n")).toContain("registered hidden")
  })

  it("positive control: the historical `--branch` flag `bay open` never had (23055 flavour 2)", () => {
    const surface = liveSurface()
    const shipped = "Open it first:\n  yrd bay open --bay <name> --branch task/x\n"
    expect(
      citationsIn(shipped, "control")
        .flatMap((citation) => offences(surface, citation))
        .join("\n"),
    ).toContain("does not declare")
  })

  it("negative control: a correct cure is not flagged", () => {
    // Every clause the fixes now print. If this ever fails, the validator has
    // started crying wolf and its offender list cannot be trusted.
    const surface = liveSurface()
    const cured =
      "stop the current attempt ('yrd cancel <selector>'), then retire the standing submission by moving the " +
      "branch back to draft ('yrd draft <branch>') or shelving it ('yrd archive <branch>'). Push the branch and " +
      "submit it plainly ('yrd pr submit <branch>'):\n  yrd bay open --bay <name>\n  yrd bay refresh <name>\n"
    expect(citationsIn(cured, "control").flatMap((citation) => offences(surface, citation))).toEqual([])
  })
})
