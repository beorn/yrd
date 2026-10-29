/**
 * @failure  31060: Yrd compared issue references as raw strings, so `26585`, `#26585` and the issue's path were three
 *           issues to submit and drop. Legacy equal raws skip the provider; witnessed raws (31306) always check
 *           live identity, preserving an exact witness only when unavailable. Ambiguity and disagreement never
 *           borrow its key. Every failed resolution retains what the provider actually returned.
 * @level    l2 (temporary real Git repositories and a real provider process)
 * @testonly none
 * @consumer yrd submit, yrd env open and yrd drop issue checks
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { issueComparer } from "../src/issue-sameness.ts"

const TMP = realpathSync(tmpdir())
const roots: string[] = []

afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: TMP, allowedRoots: [TMP], allowMissing: true })
})

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.toString()}`)
}

/** A project whose main carries `issues.yml` with these verbs, or none at all. */
function project(verbs?: (root: string) => Readonly<Record<string, readonly string[]>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-sameness-")))
  roots.push(root)
  git(root, "init", "--quiet", "-b", "main")
  writeFileSync(join(root, "README"), "project\n")
  if (verbs !== undefined) writeFileSync(join(root, "issues.yml"), JSON.stringify(verbs(root)))
  git(root, "add", ".")
  git(root, "commit", "--quiet", "-m", "project")
  return root
}

/** A `resolve` provider that logs each raw it is asked (untracked, beside the declaration), then runs `body`. */
const resolving = (body: string): string =>
  project((root) => ({
    resolve: [
      "sh",
      "-c",
      `printf '%s\\n' "$1" >> ${JSON.stringify(join(root, ".calls"))}; ${body}`,
      "resolve",
      "<raw>",
    ],
  }))

const calls = (root: string): string[] =>
  existsSync(join(root, ".calls")) ? readFileSync(join(root, ".calls"), "utf8").split("\n").filter(Boolean) : []

const ONE_ISSUE = `case "$1" in 26585|'#26585'|@hh/tooling/26585-proof) printf '{"keys":["k-26585"]}\\n';; 31060) printf '{"keys":["k-31060"]}\\n';; *) printf '{"keys":["k-other"]}\\n';; esac`

const comparer = (root: string, timeoutMs?: number) =>
  issueComparer({ projectRoot: root, cwd: root, stderr: () => {}, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
const rawOnly = (raw: string) => ({ kind: "raw-only", raw }) as const

describe("issueComparer (31060)", () => {
  it("byte-equal keys are one issue and never run the provider", async () => {
    const root = resolving(ONE_ISSUE)
    expect(await comparer(root)(rawOnly("@hh/tooling/26585-proof"), rawOnly("@hh/tooling/26585-proof"))).toEqual({
      same: true,
    })
    expect(calls(root)).toEqual([])
  })

  it("two spellings resolving to one key are one issue; each distinct raw is resolved once per comparer", async () => {
    const root = resolving(ONE_ISSUE)
    const same = comparer(root)
    expect(await same(rawOnly("26585"), rawOnly("@hh/tooling/26585-proof"))).toEqual({ same: true, key: "k-26585" })
    expect(await same(rawOnly("#26585"), rawOnly("@hh/tooling/26585-proof"))).toEqual({ same: true, key: "k-26585" })
    expect(await same(rawOnly("26585"), rawOnly("31060"))).toEqual({ same: false, resolved: true })
    expect(calls(root).sort()).toEqual(["#26585", "26585", "31060", "@hh/tooling/26585-proof"])
    // A new invocation's comparer never reuses the earlier answers.
    expect(await comparer(root)(rawOnly("26585"), rawOnly("#26585"))).toEqual({ same: true, key: "k-26585" })
    expect(calls(root).filter((raw) => raw === "26585")).toHaveLength(2)
  })

  it.each([
    {
      name: "a failing provider, naming its own stderr line",
      body: `printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1`,
      says: ['"nope": issue not found in saved state', "provider ended with exit 1"],
    },
    {
      name: "zero keys",
      body: `printf '{"keys":[]}\\n'`,
      says: ["expected {keys: [...]} with at least one nonempty string"],
    },
    {
      name: "more than one key",
      body: `printf '{"keys":["k-a","k-b"]}\\n'`,
      says: ["returned 2 keys (k-a, k-b), not one issue"],
    },
  ])("no answer from $name falls back to exact and names both spellings and the outcome", async ({ body, says }) => {
    const root = resolving(body)
    const judged = await comparer(root)(rawOnly("26585"), rawOnly("nope"))
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain("26585")
    expect(why).toContain("nope")
    for (const text of says) expect(why).toContain(text)
  })

  it("a provider that outlives the bound falls back to exact and says it was killed", async () => {
    const root = resolving("sleep 5")
    const judged = await comparer(root, 200)(rawOnly("26585"), rawOnly("#26585"))
    expect(judged).toMatchObject({ same: false, resolved: false })
    expect("why" in judged ? judged.why : "").toMatch(/resolve 26585: .*killed after 200 ms/u)
  })

  it.each([
    { name: "no issues.yml", verbs: undefined },
    { name: "an issues.yml without resolve", verbs: { view: ["sh", "-c", "printf '{}'"] } },
  ])("$name falls back to exact and says no store was asked", async ({ verbs }) => {
    const root = project(verbs === undefined ? undefined : () => verbs)
    const judged = await comparer(root)(rawOnly("26585"), rawOnly("#26585"))
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain(`26585 was not checked against an issues store, because ${root} declares none for it`)
    expect(why).toContain("#26585 was not checked against an issues store")
  })
})

// Accepted #31306: only an exact witnessed raw can survive a missing live spelling; live disagreement and
// ambiguity cannot borrow its key. The legacy-only cases above carry no witness and cannot prove this boundary.
describe("witnessed issue identity after rename (31306)", () => {
  const bound = { kind: "witnessed", raw: "old-path", key: "k-bound" } as const
  const legacyOld = { kind: "raw-only", raw: "old-path" } as const
  const current = { kind: "raw-only", raw: "current-path" } as const

  it("an unresolved witnessed old path and a live current path supply the same opaque key", async () => {
    const root = resolving(
      `case "$1" in old-path) printf 'old path unavailable\\n' >&2; exit 1;; *) printf '{"keys":["k-bound"]}\\n';; esac`,
    )
    const judged = await comparer(root)(bound, current)
    expect(judged).toMatchObject({ same: true, key: "k-bound" })
    expect("why" in judged ? judged.why : "").toContain("old path unavailable")
    expect(calls(root).sort()).toEqual(["current-path", "old-path"])
  })

  it("byte-equal witnessed raw still resolves live and refuses a reused path's different key", async () => {
    const root = resolving(`printf '{"keys":["k-reused"]}\\n'`)
    const judged = await comparer(root)(bound, legacyOld)
    expect(judged).toMatchObject({ same: false, resolved: true })
    const why = "why" in judged ? judged.why : ""
    for (const fact of ["old-path", "k-bound", "k-reused"]) expect(why).toContain(fact)
    expect(calls(root)).toEqual(["old-path"])
  })

  it("an outage permits exact-raw witness fallback while retaining its failure reason", async () => {
    const root = resolving("printf 'provider offline\\n' >&2; exit 1")
    const judged = await comparer(root)(bound, legacyOld)
    expect(judged).toMatchObject({ same: true, key: "k-bound" })
    expect("why" in judged ? judged.why : "").toContain("provider offline")
    expect(calls(root)).toEqual(["old-path"])
  })

  it("an unrelated unresolved spelling never inherits the old path's witness", async () => {
    const root = resolving("printf 'not found\\n' >&2; exit 1")
    const judged = await comparer(root)(bound, { kind: "raw-only", raw: "unrelated-path" })
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    for (const fact of ["old-path", "unrelated-path", "not found"]) expect(why).toContain(fact)
  })

  it("multiple live keys stay ambiguous even when one equals the witness", async () => {
    const root = resolving(
      `case "$1" in old-path) printf '{"keys":["k-bound","k-other"]}\\n';; *) printf '{"keys":["k-bound"]}\\n';; esac`,
    )
    const judged = await comparer(root)(bound, current)
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    for (const fact of ["old-path", "k-bound", "k-other"]) expect(why).toContain(fact)
    expect(why).toContain("returned 2 keys")
    expect(calls(root).sort()).toEqual(["current-path", "old-path"])
  })

  it("contradictory witnesses on one exact raw cannot authorize identity", async () => {
    const root = resolving("printf 'provider offline\\n' >&2; exit 1")
    const judged = await comparer(root)(bound, { kind: "witnessed", raw: "old-path", key: "k-other-witness" })
    expect(judged).toMatchObject({ same: false, resolved: true })
    const why = "why" in judged ? judged.why : ""
    for (const fact of ["old-path", "k-bound", "k-other-witness"]) expect(why).toContain(fact)
  })
})
