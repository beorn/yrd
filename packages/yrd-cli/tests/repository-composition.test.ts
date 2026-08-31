/**
 * @failure A composition host's repository aliases are hardcoded in an out-of-tree launcher, so `yrd queue run <repository>` only works through that launcher and a malformed declaration degrades into a standalone invocation that answers about the wrong repository.
 * @level l2
 * @consumer @yrd/cli composition hosts declaring named repositories, and operators typing `yrd queue <repository> …`
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  YRD_REPOSITORY_ALIASES_ENV,
  YRD_REPOSITORY_ALIASES_SCHEMA,
  composeYrdArgv,
  planYrdComposition,
  takeYrdComposition,
  yrdCompositionQueueHelp,
  type YrdComposition,
} from "../src/repository-composition.ts"

const roots: string[] = []

function initRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const real = execFileSync("bash", ["-c", `cd ${JSON.stringify(root)} && pwd -P`], { encoding: "utf8" }).trim()
  execFileSync("git", ["init", "-q", real])
  return real
}

function declaration(repositories: readonly Readonly<{ name: string; path: string; base: string }>[], root?: string) {
  return JSON.stringify({
    schema: YRD_REPOSITORY_ALIASES_SCHEMA,
    ...(root === undefined ? {} : { root }),
    repositories,
  })
}

/** The two-repository composition every expectation below is written against. */
function twoRepositories(root: string) {
  return declaration(
    [
      { name: "code", path: ".", base: "main" },
      { name: "pm", path: "pm", base: "main" },
    ],
    root,
  )
}

/** Plans without touching Git: authority resolution has its own suite. */
const identityAuthority = (path: string) => path

function requireComposition(raw: string): YrdComposition {
  const composition = takeYrdComposition({ [YRD_REPOSITORY_ALIASES_ENV]: raw })
  if (composition === undefined) throw new Error("test declared a composition and got none")
  return composition
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("takeYrdComposition", () => {
  it("leaves standalone Yrd with no composition at all", () => {
    expect(takeYrdComposition({})).toBeUndefined()
  })

  it("consumes the declaration so a spawned step cannot inherit it", () => {
    const env: Record<string, string | undefined> = { [YRD_REPOSITORY_ALIASES_ENV]: twoRepositories("/repo") }
    expect(takeYrdComposition(env)?.aliases).toHaveLength(2)
    expect(env[YRD_REPOSITORY_ALIASES_ENV]).toBeUndefined()
  })

  it("projects each declaration into the alias shape the normalizer consumes", () => {
    const composition = requireComposition(twoRepositories("/repo"))
    expect(composition).toEqual({
      root: "/repo",
      aliases: [
        { repository: { name: "code", path: "." }, queue: { base: "main" } },
        { repository: { name: "pm", path: "pm" }, queue: { base: "main" } },
      ],
    })
  })

  it.each([
    { raw: "not json", message: `${YRD_REPOSITORY_ALIASES_ENV} must contain valid JSON` },
    { raw: "[]", message: `${YRD_REPOSITORY_ALIASES_ENV} must be an object` },
    { raw: `{"repositories":[]}`, message: `${YRD_REPOSITORY_ALIASES_ENV}.schema must be` },
    {
      raw: `{"schema":"${YRD_REPOSITORY_ALIASES_SCHEMA}"}`,
      message: `${YRD_REPOSITORY_ALIASES_ENV}.repositories must be a non-empty array`,
    },
    {
      raw: `{"schema":"${YRD_REPOSITORY_ALIASES_SCHEMA}","repositories":[{"name":"","path":".","base":"main"}]}`,
      message: `${YRD_REPOSITORY_ALIASES_ENV}.repositories[0].name must be a non-empty string`,
    },
    {
      raw: `{"schema":"${YRD_REPOSITORY_ALIASES_SCHEMA}","repositories":[{"name":"code","base":"main"}]}`,
      message: `${YRD_REPOSITORY_ALIASES_ENV}.repositories[0].path must be a non-empty string`,
    },
    {
      raw:
        `{"schema":"${YRD_REPOSITORY_ALIASES_SCHEMA}","repositories":` +
        `[{"name":"code","path":".","base":"main"},{"name":"code","path":"pm","base":"main"}]}`,
      message: `${YRD_REPOSITORY_ALIASES_ENV} declares repository 'code' twice`,
    },
    {
      raw: `{"schema":"${YRD_REPOSITORY_ALIASES_SCHEMA}","root":5,"repositories":[{"name":"c","path":".","base":"m"}]}`,
      message: `${YRD_REPOSITORY_ALIASES_ENV}.root must be a non-empty string`,
    },
  ])("refuses a malformed declaration rather than falling back to standalone: $message", ({ raw, message }) => {
    expect(() => takeYrdComposition({ [YRD_REPOSITORY_ALIASES_ENV]: raw })).toThrow(message)
  })
})

describe("planYrdComposition", () => {
  const composition = requireComposition(twoRepositories("/repo"))

  it("routes a named write to that repository and replaces the alias with its authority", () => {
    const plan = planYrdComposition(["queue", "run", "code"], composition, {
      env: {},
      authority: (path) => `/authority${path === "/repo" ? "" : path}`,
    })
    expect(plan).toEqual({
      kind: "repository",
      repository: { name: "code", path: "/authority" },
      args: ["--repo", "/authority", "queue", "run"],
    })
  })

  it("resolves a relative declared path against the declared composition root", () => {
    const seen: string[] = []
    planYrdComposition(["queue", "run", "pm"], composition, {
      env: {},
      authority: (path) => {
        seen.push(path)
        return path
      },
    })
    expect(seen).toEqual([join("/repo", "pm")])
  })

  it("spans every declared repository when a read names none", () => {
    const plan = planYrdComposition(["queue"], composition, { env: {}, authority: identityAuthority })
    expect(plan).toEqual({
      kind: "all-repositories",
      args: ["queue", "list"],
      repositories: [
        { name: "code", path: "/repo" },
        { name: "pm", path: join("/repo", "pm") },
      ],
    })
  })

  it("resolves bare `yrd watch` to the repository containing the invocation directory (item 35)", () => {
    // #undead (operator ruling 2026-08-18): the all-repository watch refusal
    // is dead. The watch is a pure reader whose DEFAULT discovery tier is
    // the current repository (item 37f) — cwd inside a declared repository
    // picks it; a cwd inside a nested declaration picks the deepest match's
    // declaration order (first containing match wins here: pm's path nests
    // under /repo, so a pm cwd matches /repo first only if /repo is listed
    // first — the declaration order is the tiebreak the composition owns).
    const fromCode = planYrdComposition(["queue", "list", "--watch"], composition, {
      env: {},
      cwd: "/repo",
      authority: identityAuthority,
    })
    expect(fromCode).toEqual({
      kind: "repository",
      repository: { name: "code", path: "/repo" },
      args: ["--repo", "/repo", "queue", "list", "--watch"],
    })

    // Outside every declared repository the primary (first) declaration wins.
    const fromElsewhere = planYrdComposition(["watch"], composition, {
      env: {},
      cwd: "/somewhere/else",
      authority: identityAuthority,
    })
    expect(fromElsewhere).toEqual({
      kind: "repository",
      repository: { name: "code", path: "/repo" },
      args: ["--repo", "/repo", "queue", "list", "--watch"],
    })

    // The dead refusal never fires from any watch spelling.
    for (const args of [["watch"], ["queue", "watch"], ["queue", "--watch"]]) {
      expect(() =>
        planYrdComposition(args, composition, { env: {}, cwd: "/repo", authority: identityAuthority }),
      ).not.toThrow()
    }
  })

  it.each([
    { label: "--repo", args: ["--repo", "/elsewhere", "queue", "run"], env: {} },
    { label: "--repo=", args: ["--repo=/elsewhere", "queue", "run"], env: {} },
    { label: "YRD_REPO", args: ["queue", "run"], env: { YRD_REPO: "/elsewhere" } },
    { label: "--help", args: ["queue", "--help"], env: {} },
    { label: "-h", args: ["queue", "-h"], env: {} },
    { label: "--version", args: ["--version"], env: {} },
    { label: "a non-queue command", args: ["pr", "list"], env: {} },
  ])("leaves $label alone for the runtime to answer", ({ args, env }) => {
    expect(planYrdComposition(args, composition, { env, authority: identityAuthority })).toEqual({
      kind: "bypass",
      args,
    })
  })

  it("refuses an undeclared repository by naming the declared alternatives", () => {
    expect(() =>
      planYrdComposition(["queue", "run", "nope"], composition, { env: {}, authority: identityAuthority }),
    ).toThrow("unknown Yrd repository 'nope'; expected code or pm")
  })

  it("keeps the operation repository reachable for out-of-band state", () => {
    const repo = initRepository("yrd-composition-authority-")
    const single = requireComposition(declaration([{ name: "code", path: ".", base: "main" }], repo))
    const plan = planYrdComposition(["queue", "run", "code"], single, { env: {} })
    expect(plan).toMatchObject({ kind: "repository", repository: { name: "code", path: repo } })
  })

  it("defaults an omitted write to the sole declared repository instead of demanding ceremony", () => {
    // A required argument that names the only legal value carries no
    // information — `yrd queue run` has exactly one repository it could mean
    // while exactly one is declared. This reads live off the declared set
    // (never a hardcoded name), so it stops applying the moment a second
    // repository is declared: `requiredRepository`'s `byName.size === 1`
    // check goes false and the explicit name becomes required again with no
    // further change here.
    const repo = initRepository("yrd-composition-default-")
    const single = requireComposition(declaration([{ name: "code", path: ".", base: "main" }], repo))
    const plan = planYrdComposition(["queue", "run"], single, { env: {} })
    expect(plan).toMatchObject({ kind: "repository", repository: { name: "code", path: repo } })
  })

  it("still requires an explicit repository for a write once a second is declared, and the refusal names the fix", () => {
    // The counterpart to the default above: two declared repositories means
    // the omission is genuinely ambiguous, so it must still refuse — but the
    // refusal now says a value was never typed (not "" as if it were) and
    // names the exact command, using the verb the operator actually typed.
    expect(() => planYrdComposition(["queue", "run"], composition, { env: {}, authority: identityAuthority })).toThrow(
      "unknown Yrd repository ''; expected code or pm; none was given — run 'yrd queue run code' to name one",
    )
  })

  it("distinguishes an omitted repository from a typo in the same refusal shape", () => {
    // A typo'd repository name is a different condition from an omitted one
    // and keeps the plain "unknown ... expected ..." message with no
    // appended remedy clause — the operator already typed a concrete (wrong)
    // value, so there is nothing to clarify about intent, only spelling.
    expect(() =>
      planYrdComposition(["queue", "run", "nope"], composition, { env: {}, authority: identityAuthority }),
    ).toThrow("unknown Yrd repository 'nope'; expected code or pm")
    expect(() =>
      planYrdComposition(["queue", "run", "nope"], composition, { env: {}, authority: identityAuthority }),
    ).not.toThrow(/none was given/)
  })
})

describe("composeYrdArgv", () => {
  it.each([
    {
      argv: ["/usr/bin/bun", "/repo/bin/yrd", "queue", "run", "code"],
      expected: ["/usr/bin/bun", "/repo/bin/yrd", "--repo", "/authority", "queue", "run"],
    },
    {
      argv: ["git", "yrd", "queue", "run", "code"],
      expected: ["git", "yrd", "--repo", "/authority", "queue", "run"],
    },
  ])("preserves the executable prefix of $argv", ({ argv, expected }) => {
    expect(composeYrdArgv(argv, ["--repo", "/authority", "queue", "run"])).toEqual(expected)
  })
})

describe("yrdCompositionQueueHelp", () => {
  it("names every declared repository and both read and write spellings", () => {
    const help = yrdCompositionQueueHelp("git yrd", requireComposition(twoRepositories("/repo")))
    expect(help).toContain("Composition repositories: code, pm")
    expect(help).toContain("Reads: git yrd queue [code|pm]")
    expect(help).toContain(`git yrd queue pause code --reason "maintenance"`)
  })
})
