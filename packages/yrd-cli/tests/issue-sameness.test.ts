/**
 * @failure  31060: Yrd compared issue references as raw strings, so `26585`, `#26585` and the issue's path were three
 *           issues to submit and drop. The one comparer asks the project's declared `resolve` verb only for differing
 *           keys; any answer that is not exactly one key per raw falls back to exact comparison and must say what
 *           resolve returned, never silently equal and never silently unequal (@cto ruling 26852baa, bindings 2–3).
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

describe("issueComparer (31060)", () => {
  it("byte-equal keys are one issue and never run the provider", async () => {
    const root = resolving(ONE_ISSUE)
    expect(await comparer(root)("@hh/tooling/26585-proof", "@hh/tooling/26585-proof")).toEqual({ same: true })
    expect(calls(root)).toEqual([])
  })

  it("two spellings resolving to one key are one issue; each distinct raw is resolved once per comparer", async () => {
    const root = resolving(ONE_ISSUE)
    const same = comparer(root)
    expect(await same("26585", "@hh/tooling/26585-proof")).toEqual({ same: true })
    expect(await same("#26585", "@hh/tooling/26585-proof")).toEqual({ same: true })
    expect(await same("26585", "31060")).toEqual({ same: false, resolved: true })
    expect(calls(root).sort()).toEqual(["#26585", "26585", "31060", "@hh/tooling/26585-proof"])
    // A new invocation's comparer never reuses the earlier answers.
    expect(await comparer(root)("26585", "#26585")).toEqual({ same: true })
    expect(calls(root).filter((raw) => raw === "26585")).toHaveLength(2)
  })

  it.each([
    {
      name: "a failing provider, naming its own stderr line",
      body: `printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1`,
      says: ["nope no longer resolves", '"nope": issue not found in saved state'],
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
    const judged = await comparer(root)("26585", "nope")
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain("26585")
    expect(why).toContain("nope")
    for (const text of says) expect(why).toContain(text)
  })

  it("a provider that outlives the bound falls back to exact and says it was killed", async () => {
    const root = resolving("sleep 5")
    const judged = await comparer(root, 200)("26585", "#26585")
    expect(judged).toMatchObject({ same: false, resolved: false })
    expect("why" in judged ? judged.why : "").toMatch(/resolve 26585: .*killed after 200 ms/u)
  })

  it("a missing path names the one issue its leaf resolves to now", async () => {
    const root = resolving(
      `case "$1" in @pm/infra/old/31262-name) printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1;; 31262-name) printf '{"keys":["@pm/infra/31262-name"]}\\n';; @pm/infra/old/shared) printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1;; shared) printf '{"keys":["k-a","k-b"]}\\n';; *) printf '{"keys":["k-other"]}\\n';; esac`,
    )
    const named = await comparer(root)("@pm/infra/old/31262-name", "31262")
    expect(named).toMatchObject({ same: false, resolved: false })
    const why = "why" in named ? named.why : ""
    expect(why).toContain("@pm/infra/old/31262-name no longer resolves")
    expect(why).toContain("the current issue is @pm/infra/31262-name")
    const ambiguous = await comparer(root)("@pm/infra/old/shared", "other")
    const ambiguousWhy = "why" in ambiguous ? ambiguous.why : ""
    expect(ambiguousWhy).not.toContain("the current issue is")
    expect(ambiguousWhy).toContain("resolve shared returned 2 keys (k-a, k-b), not one issue")
  })

  it("a missing path keeps a timed-out leaf lookup in the why", async () => {
    const root = resolving(
      `case "$1" in old/path) printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1;; path) sleep 5;; *) printf '{"keys":["k-other"]}\\n';; esac`,
    )
    const judged = await comparer(root, 300)("old/path", "other")
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain("old/path no longer resolves")
    expect(why).toMatch(/resolve path: .*killed after 300 ms/u)
    expect(why).not.toContain("the current issue is")
    expect(calls(root).filter((raw) => raw === "path")).toHaveLength(1)
  })

  it("a missing path keeps a failed leaf lookup in the why", async () => {
    const root = resolving(
      `case "$1" in old/path) printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1;; path) printf 'leaf failed for real\\n' >&2; exit 9;; *) printf '{"keys":["k-other"]}\\n';; esac`,
    )
    const judged = await comparer(root)("old/path", "other")
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain("old/path no longer resolves")
    expect(why).toContain("provider ended with exit 9")
    expect(why).not.toContain("the current issue is")
  })

  it("two missing paths ask their shared leaf once", async () => {
    const root = resolving(
      `case "$1" in old/path|legacy/path) printf '"%s": issue not found in saved state\\n' "$1" >&2; exit 1;; path) printf '{"keys":["@pm/infra/path"]}\\n';; *) printf '{"keys":["k-other"]}\\n';; esac`,
    )
    const judged = await comparer(root)("old/path", "legacy/path")
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain("old/path no longer resolves")
    expect(why).toContain("legacy/path no longer resolves")
    expect(why).toContain("the current issue is @pm/infra/path")
    expect(calls(root).filter((raw) => raw === "path")).toHaveLength(1)
    expect(calls(root).filter((raw) => raw === "old/path")).toHaveLength(1)
    expect(calls(root).filter((raw) => raw === "legacy/path")).toHaveLength(1)
  })

  it("a missing-issue line followed by a timeout stays a timeout", async () => {
    const root = resolving(`printf '"%s": issue not found in saved state\\n' "$1" >&2; sleep 5`)
    const judged = await comparer(root, 300)("26585", "nope")
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toMatch(/killed after 300 ms/u)
    expect(why).not.toContain("no longer resolves")
  })

  it.each([
    { name: "no issues.yml", verbs: undefined },
    { name: "an issues.yml without resolve", verbs: { view: ["sh", "-c", "printf '{}'"] } },
  ])("$name falls back to exact and says no store was asked", async ({ verbs }) => {
    const root = project(verbs === undefined ? undefined : () => verbs)
    const judged = await comparer(root)("26585", "#26585")
    expect(judged).toMatchObject({ same: false, resolved: false })
    const why = "why" in judged ? judged.why : ""
    expect(why).toContain(`26585 was not checked against an issues store, because ${root} declares none for it`)
    expect(why).toContain("#26585 was not checked against an issues store")
  })
})
