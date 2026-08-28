/**
 * @failure A retired verb's refusal prints a cure the operator cannot run: the
 * verb it just retired, a command that is registered nowhere, or a SECOND
 * retired verb. The S7 shape (branch-is-change, @i/10 22991): the deleted
 * `withdrawPrs` refused by naming `yrd cancel`, whose own description named
 * `mr close` as ITS cure — a two-command circle with no exit for the operator.
 * Naming a command that refuses is the same defect as naming none, and a
 * retirement is the one refusal that ships a cure by construction.
 * @level l1
 * @consumer @yrd/cli retired-verb refusals
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runYrd, yrdCommandSurface } from "../src/run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO } from "../src/types.ts"

/**
 * Every retired verb, with an invocation Commander accepts — some take a
 * required selector, and without one the walk earns a missing-argument usage
 * error instead of reaching the refusal.
 *
 * Spelled out rather than derived: this table is the exhaustiveness ratchet.
 * The last three tests fail when the CLI grows a retirement missing from here,
 * when the source registry grows an entry missing from here, and when a row
 * here names a verb that is live again or gone.
 */
const RETIRED_VERB_INVOCATIONS = {
  // `RETIRED_CHANGE_RECORD_VERBS`, the eleven record-lane writers.
  "pr create": ["pr", "create"],
  "pr close": ["pr", "close", "SELECTOR"],
  "pr withdraw": ["pr", "withdraw", "SELECTOR"],
  "pr edit": ["pr", "edit", "SELECTOR"],
  "pr review": ["pr", "review", "SELECTOR"],
  "pr request-review": ["pr", "request-review", "SELECTOR"],
  "pr comment": ["pr", "comment", "SELECTOR"],
  "pr ready": ["pr", "ready", "SELECTOR"],
  "pr publish": ["pr", "publish", "SELECTOR"],
  "admin pr prune": ["admin", "pr", "prune"],
  "issue ensure": ["issue", "ensure", "ISSUE"],
  // The siblings, each with its own refusal function rather than a registry row.
  "queue candidate-refs": ["queue", "candidate-refs"],
  "queue recover": ["queue", "recover"],
  "admin queue init": ["admin", "queue", "init"],
  "admin queue deinit": ["admin", "queue", "deinit"],
} as const satisfies Record<string, readonly string[]>

type RetiredVerb = keyof typeof RETIRED_VERB_INVOCATIONS

/** `pr` is registered with aliases `mr` and `change`, and `yrdCommandSurface`
 * lists every spelling as its own path. Collapse them so the coverage ratchet
 * counts one retirement rather than three. */
const CHANGE_NOUN_ALIASES = ["mr", "change"] as const

const SURFACE = yrdCommandSurface()
const BY_PATH = new Map(SURFACE.map((fact) => [fact.path, fact]))

function canonicalPath(path: string): string {
  for (const alias of CHANGE_NOUN_ALIASES) {
    if (path === alias || path.startsWith(`${alias} `)) return `pr${path.slice(alias.length)}`
  }
  return path
}

/**
 * The registry's RAW values, read out of `run.ts` because it keeps
 * `RETIRED_CHANGE_RECORD_VERBS` module private.
 *
 * Raw and not rendered on purpose. Yrd's actionable-error layer lifts a quoted
 * `'yrd …'` out of the message into a `resolve:` field and DISCARDS prose around
 * it — `queue candidate-refs` renders as its first four words plus two
 * `resolve:` lines — so a cure written without quotes would vanish before any
 * rendered assertion could see it. The rendered form is checked separately
 * below, and cross-checked against this raw one.
 */
function retiredChangeRecordVerbs(): ReadonlyMap<string, string> {
  const source = readFileSync(join(import.meta.dirname, "../src/run.ts"), "utf8")
  const open = "const RETIRED_CHANGE_RECORD_VERBS = {"
  const start = source.indexOf(open)
  expect(start, "run.ts no longer declares RETIRED_CHANGE_RECORD_VERBS as a plain object literal").toBeGreaterThan(-1)
  const end = source.indexOf("\n} as const", start)
  expect(end, "RETIRED_CHANGE_RECORD_VERBS is no longer closed by `} as const`").toBeGreaterThan(start)
  const block = source.slice(start + open.length, end)
  const keys = [...block.matchAll(/^ {2}"([^"]+)":/gmu)]
  // A silent zero here would read as "no retired verb misbehaves". Two facts
  // have to hold before that reading is earned: entries were found at all, and
  // each one carries text.
  expect(
    keys.length,
    "extracted no entries from RETIRED_CHANGE_RECORD_VERBS; the literal's shape changed",
  ).toBeGreaterThan(0)
  const entries = new Map<string, string>()
  for (const [index, key] of keys.entries()) {
    const from = (key.index ?? 0) + key[0].length
    const to = index + 1 < keys.length ? (keys[index + 1]?.index ?? block.length) : block.length
    const literals = [...block.slice(from, to).matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((part) => part[1] ?? "")
    const message = literals.join("")
    expect(message, `RETIRED_CHANGE_RECORD_VERBS['${key[1]}'] extracted to an empty message`).not.toBe("")
    entries.set(key[1] ?? "", message)
  }
  return entries
}

const REGISTRY = retiredChangeRecordVerbs()

type Reference = Readonly<{ spelled: string; path: string; live: boolean | undefined }>

/**
 * Every `yrd …` command a text recommends, resolved against the real command
 * tree. The longest registered prefix wins, so `yrd pr submit <branch>` resolves
 * to `pr submit` and the placeholder is not mistaken for a subcommand.
 *
 * An occurrence at index 0 is the message's own SUBJECT — `yrd intent is
 * retired` names the verb being retired, not a cure. The `yrd:` prefix the
 * registry messages open with is already excluded: the token class starts at
 * `[a-z]`, and `:` is not one.
 */
function commandReferences(text: string): readonly Reference[] {
  const found: Reference[] = []
  for (const match of text.matchAll(/\byrd((?:[ \t]+[a-z][a-z0-9-]*)+)/gu)) {
    if (match.index === 0) continue
    const tokens = (match[1] ?? "").trim().split(/[ \t]+/u)
    const spelled = tokens.join(" ")
    const resolved = tokens
      .map((_token, index) => tokens.slice(0, tokens.length - index).join(" "))
      .find((candidate) => BY_PATH.has(candidate))
    // A PROPER prefix is not a resolution: `yrd pr frobnicate` matching the
    // live group `yrd pr` is a command the operator cannot run, and reporting
    // it as live is exactly the false all-clear this file exists to prevent.
    // `path` still carries the nearest registered ancestor, because naming it
    // is what makes the failure readable.
    found.push({
      spelled,
      path: resolved ?? spelled,
      live: resolved === spelled ? BY_PATH.get(resolved)?.live : undefined,
    })
  }
  return found
}

async function refuse(argv: readonly string[]): Promise<{ exit: YrdCliExitCode; text: string }> {
  let text = ""
  const io: YrdCliIO = {
    stdout: (chunk: string) => {
      text += chunk
    },
    stderr: (chunk: string) => {
      text += chunk
    },
  }
  // `executeYrd` types its app as optional and every retired verb refuses before
  // reading it; only the exported `runYrd` narrows the parameter.
  const exit = await runYrd(undefined as unknown as YrdCliApp, argv, io)
  return { exit, text }
}

/** The cures the operator actually sees, which is exactly the `resolve:` lines:
 * the `error:` line is the description, and its subject is the retired verb. */
function resolveLines(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("resolve: "))
    .map((line) => line.slice("resolve: ".length).trim())
}

describe("a retirement never prints a cure the operator cannot run", () => {
  it("recommends no command that is not registered at all", () => {
    const offenders: string[] = []
    for (const [verb, message] of REGISTRY) {
      for (const reference of commandReferences(message)) {
        if (reference.live === undefined) {
          offenders.push(
            `'${verb}' retirement recommends 'yrd ${reference.spelled}', which is not a registered command`,
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("never recommends the verb it just retired", () => {
    // Kept separate from the retired-cure walk below even though that one
    // subsumes it today: this names the circle for what it is, and it still
    // fires if a verb is ever retired while left visible.
    const offenders: string[] = []
    for (const [verb, message] of REGISTRY) {
      for (const reference of commandReferences(message)) {
        if (reference.path === verb || reference.spelled === verb) {
          offenders.push(`'${verb}' retirement recommends 'yrd ${verb}', the verb it just retired`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("recommends no command that is itself retired", () => {
    // `live` is false for a verb registered hidden, which is how every retired
    // verb is registered — so this also catches a self-reference spelled with
    // another noun, `yrd mr close` inside the `pr close` retirement.
    const offenders: string[] = []
    for (const [verb, message] of REGISTRY) {
      for (const reference of commandReferences(message)) {
        if (reference.live === false) {
          offenders.push(`'${verb}' retirement recommends 'yrd ${reference.path}', which is itself retired`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("prints only runnable cures in what the operator sees, for every retired verb including the four with no registry row", async () => {
    const offenders: string[] = []
    for (const [verb, argv] of Object.entries(RETIRED_VERB_INVOCATIONS) as [RetiredVerb, readonly string[]][]) {
      const { exit, text } = await refuse(argv)
      if (exit !== 1) {
        offenders.push(`'yrd ${argv.join(" ")}' exited ${exit} instead of refusing:\n${text}`)
        continue
      }
      // The verb is wired to its own refusal, not to some other verb's.
      if (!text.includes(`${verb} is retired`)) {
        offenders.push(`'yrd ${argv.join(" ")}' did not refuse as '${verb} is retired':\n${text}`)
      }
      for (const cure of resolveLines(text)) {
        for (const reference of commandReferences(`x ${cure}`)) {
          if (reference.live === undefined) {
            offenders.push(`'${verb}' resolves to 'yrd ${reference.spelled}', which is not a registered command`)
          } else if (!reference.live) {
            offenders.push(`'${verb}' resolves to 'yrd ${reference.path}', which is itself retired`)
          } else if (reference.path === verb || reference.spelled === verb) {
            offenders.push(`'${verb}' resolves to 'yrd ${verb}', the verb it just retired`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("loses no cure between the authored message and the rendered refusal", async () => {
    // The licence for reading the four registry-less retirements off rendered
    // output above. Rendering keeps every cure the raw message names — proven
    // here on the eleven whose raw text this file can read — so a cure the
    // operator never sees, or one rendering invents, fails here first.
    const offenders: string[] = []
    for (const [verb, argv] of Object.entries(RETIRED_VERB_INVOCATIONS) as [RetiredVerb, readonly string[]][]) {
      const message = REGISTRY.get(verb)
      if (message === undefined) continue
      const authored = new Set(commandReferences(message).map((reference) => reference.spelled))
      const rendered = new Set(
        resolveLines((await refuse(argv)).text).flatMap((cure) =>
          commandReferences(`x ${cure}`).map((reference) => reference.spelled),
        ),
      )
      if (authored.size !== rendered.size || [...authored].some((path) => !rendered.has(path))) {
        offenders.push(
          `'${verb}' authors [${[...authored].toSorted().join(", ")}] but renders [${[...rendered].toSorted().join(", ")}]`,
        )
      }
    }
    expect(offenders).toEqual([])
  })

  it("refuses the retired `intent` verb group with a runnable cure", async () => {
    // Not a registered path — `executeYrd` intercepts `intent` ahead of
    // Commander, so it carries no row in the table above and exits 2.
    const { exit, text } = await refuse(["intent"])
    expect(exit, text).toBe(2)
    expect(text).toContain("yrd intent is retired")
    const cures = resolveLines(text)
    expect(cures.length, `the intent retirement printed no cure:\n${text}`).toBeGreaterThan(0)
    for (const cure of cures) {
      for (const reference of commandReferences(`x ${cure}`)) {
        expect(reference.live, `intent resolves to 'yrd ${reference.spelled}', which is not live`).toBe(true)
      }
    }
  })

  it("covers every retired command the CLI registers, so a new retirement cannot skip this file", () => {
    for (const alias of CHANGE_NOUN_ALIASES) {
      expect(BY_PATH.has(alias), `'${alias}' is no longer a spelling of 'pr'; the alias collapse is stale`).toBe(true)
    }
    const uncovered = SURFACE.filter((fact) => !fact.live)
      .map((fact) => canonicalPath(fact.path))
      // A leaf named `_something` is an undocumented internal, never a retirement.
      .filter((path) => !(path.split(" ").at(-1) ?? "").startsWith("_"))
      // A hidden node that only groups other paths refuses nothing of its own.
      .filter((path) => !SURFACE.some((other) => other.path.startsWith(`${path} `)))
      .filter((path) => !(path in RETIRED_VERB_INVOCATIONS))
    expect([...new Set(uncovered)].toSorted()).toEqual([])
  })

  it("holds a row for every entry in the source registry", () => {
    expect([...REGISTRY.keys()].filter((verb) => !(verb in RETIRED_VERB_INVOCATIONS))).toEqual([])
  })

  it("lists no verb that is live again or gone — a resurrected command must lose its row", () => {
    expect(Object.keys(RETIRED_VERB_INVOCATIONS).filter((path) => BY_PATH.get(path)?.live !== false)).toEqual([])
  })
})
