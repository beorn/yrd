/**
 * @failure Every compose reads each component repository from GitHub over its own ssh login, so one
 *          round opens a hundred logins for data a single fetch per repository would have brought.
 * @level   l2 (real repositories, real `clone --mirror` and `fetch --prune`, real kernel flocks)
 * @consumer the round's post-snapshot refresh and every compose on an aged mirror (25570 row 1), then
 *           25567's host service, which takes over the refresh of the same store
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, describe, expect, it } from "vitest"
import { type Git, gitIn } from "../src/git.ts"
import {
  composeEnvironment,
  MIRROR_REFRESHED_AT,
  mirrorLocation,
  type MirrorRefresh,
  MirrorUnavailable,
  refreshDeclaredMirrors,
  refreshMirror,
} from "../src/mirror.ts"
import { readRemoteCalls } from "../src/remote-calls.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=mirror@yrd.test", "-c", "user.name=yrd"] as const
const HOSTED = "git@github.com:beorn/"

/**
 * A host where `git@github.com:beorn/<repo>.git` is a local bare repository.
 *
 * The URL the mirror is keyed on has to be the real hosted form, because the
 * store's layout is derived from it; the rewrite is only how the test reaches
 * it without a network. Nothing under test sees the rewrite.
 */
function host(): Readonly<{ root: string; upstream: string; store: string; env: NodeJS.ProcessEnv }> {
  const root = mkdtempSync(join(tmpdir(), "yrd-mirror-"))
  roots.push(root)
  const upstream = join(root, "upstream", "beorn")
  mkdirSync(upstream, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Any ssh that escapes the rewrite fails here, locally, instead of asking GitHub.
    GIT_SSH_COMMAND: "false",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.file://${upstream}/.insteadOf`,
    GIT_CONFIG_VALUE_1: HOSTED,
    GIT_CONFIG_KEY_2: `url.file://${upstream}/.insteadOf`,
    GIT_CONFIG_VALUE_2: "ssh://git@github.com/beorn/",
  }
  return { root, upstream, store: join(root, "git-mirror"), env }
}

async function upstreamRepository(at: string, name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const work = join(at, ".work", name)
  mkdirSync(work, { recursive: true })
  const git = gitIn(work, undefined, undefined, { env })
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(work, `${name}.txt`), `${name}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${name}`])
  await gitIn(at, undefined, undefined, { env })(["clone", "--quiet", "--bare", work, join(at, `${name}.git`)])
  await git(["remote", "add", "origin", join(at, `${name}.git`)])
  return work
}

/** Declares `children` (path -> url) at the work tree's next commit, each gitlink at the given sha. */
async function declare(
  work: string,
  env: NodeJS.ProcessEnv,
  children: ReadonlyArray<Readonly<{ path: string; url: string; sha: string }>>,
): Promise<string> {
  const git = gitIn(work, undefined, undefined, { env })
  writeFileSync(
    join(work, ".gitmodules"),
    children.map(({ path, url }) => `[submodule "${path}"]\n\tpath = ${path}\n\turl = ${url}\n`).join(""),
  )
  for (const { path, sha } of children) await git(["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`])
  await git(["add", ".gitmodules"])
  await git([...author, "commit", "--quiet", "--message", "declare submodules"])
  await git(["push", "--quiet", "origin", "main"])
  return (await git(["rev-parse", "HEAD"])).trim()
}

async function head(work: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await gitIn(work, undefined, undefined, { env })(["rev-parse", "HEAD"])).trim()
}

/** The caller's instrumented Git, as the queue hands it over; here, one environment for every directory. */
function through(env: NodeJS.ProcessEnv): (cwd: string) => Git {
  return (cwd) => gitIn(cwd, undefined, undefined, { env })
}

function traced(env: NodeJS.ProcessEnv, root: string): Readonly<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = mkdtempSync(join(root, "trace2-"))
  return { env: { ...env, GIT_TRACE2_EVENT: dir }, dir }
}

describe("mirrorLocation", () => {
  it("keys every hosted URL form on host, owner and repository, and nothing else", () => {
    for (const url of [
      "git@github.com:beorn/yrd.git",
      "git@github.com:beorn/yrd",
      "ssh://git@github.com/beorn/yrd.git",
      "ssh://git@github.com:22/beorn/yrd",
      "https://github.com/beorn/yrd.git",
    ]) {
      expect(mirrorLocation("/store", url), url).toEqual({
        host: "github.com",
        owner: "beorn",
        repo: "yrd",
        path: "/store/github.com/beorn/yrd.git",
      })
    }
  })

  it("names no mirror for a local path, a file URL or a relative URL", () => {
    for (const url of ["/srv/git/yrd.git", "file:///srv/git/yrd.git", "../yrd.git", "./yrd"]) {
      expect(mirrorLocation("/store", url), url).toBeUndefined()
    }
  })
})

describe("refreshMirror", () => {
  it("creates a bare mirror with gc off and a refreshed-at stamp, then fetches and prunes on refresh", async () => {
    const { store, upstream, env } = host()
    const work = await upstreamRepository(upstream, "child", env)
    const git = gitIn(work, undefined, undefined, { env })
    await git(["push", "--quiet", "origin", "main", "main:refs/heads/doomed"])
    const url = `${HOSTED}child.git`

    const created = await refreshMirror({ root: store, url, gitIn: through(env) })
    expect(created).toMatchObject({ url, path: join(store, "github.com/beorn/child.git"), outcome: "created" })
    expect(created.bytes).toBeGreaterThan(0)
    const mirror = gitIn(created.path, undefined, undefined, { env })
    expect((await mirror(["config", "--get", "gc.auto"])).trim()).toBe("0")
    expect((await mirror(["rev-parse", "--is-bare-repository"])).trim()).toBe("true")
    expect((await mirror(["rev-parse", "refs/heads/main"])).trim()).toBe(await head(work, env))
    const stamped = readFileSync(join(created.path, MIRROR_REFRESHED_AT), "utf8").trim()
    expect(new Date(stamped).getTime()).toBe(created.refreshedAt.getTime())

    writeFileSync(join(work, "more.txt"), "more\n")
    await git(["add", "--all"])
    await git([...author, "commit", "--quiet", "--message", "more"])
    await git(["push", "--quiet", "origin", "main", ":refs/heads/doomed"])

    const refreshed = await refreshMirror({ root: store, url, gitIn: through(env) })
    expect(refreshed.outcome).toBe("fetched")
    expect(refreshed.refreshedAt.getTime()).toBeGreaterThanOrEqual(created.refreshedAt.getTime())
    expect((await mirror(["rev-parse", "refs/heads/main"])).trim()).toBe(await head(work, env))
    expect((await mirror(["for-each-ref", "--format=%(refname)", "refs/heads/doomed"])).trim()).toBe("")
  })

  it("does not fetch a mirror younger than the window it is asked for", async () => {
    const { root, store, upstream, env } = host()
    const work = await upstreamRepository(upstream, "child", env)
    const url = `${HOSTED}child.git`
    const created = await refreshMirror({ root: store, url, gitIn: through(env) })
    const git = gitIn(work, undefined, undefined, { env })
    writeFileSync(join(work, "late.txt"), "late\n")
    await git(["add", "--all"])
    await git([...author, "commit", "--quiet", "--message", "late"])
    await git(["push", "--quiet", "origin", "main"])

    const counted = traced(env, root)
    const fresh = await refreshMirror({ root: store, url, gitIn: through(counted.env), maxAgeMs: 10 * 60_000 })
    expect(fresh).toMatchObject({ outcome: "fresh", refreshedAt: created.refreshedAt })
    expect(readRemoteCalls(counted.dir).verbs.fetch ?? 0).toBe(0)

    const aged = await refreshMirror({ root: store, url, gitIn: through(env), maxAgeMs: 0 })
    expect(aged.outcome).toBe("fetched")
  })

  it("W3: two concurrent refreshes of one mirror make one remote fetch, and the stamp only moves forward", async () => {
    const { root, store, upstream, env } = host()
    await upstreamRepository(upstream, "child", env)
    const url = `${HOSTED}child.git`
    const created = await refreshMirror({ root: store, url, gitIn: through(env) })

    const counted = traced(env, root)
    const [left, right] = await Promise.all([
      refreshMirror({ root: store, url, gitIn: through(counted.env) }),
      refreshMirror({ root: store, url, gitIn: through(counted.env) }),
    ])
    expect([left.outcome, right.outcome].sort()).toEqual(["coalesced", "fetched"])
    expect(readRemoteCalls(counted.dir).verbs.fetch).toBe(1)
    expect(left.refreshedAt.getTime()).toBe(right.refreshedAt.getTime())
    expect(left.refreshedAt.getTime()).toBeGreaterThanOrEqual(created.refreshedAt.getTime())
  })

  it("refuses by name when the lock is held past the bound, and fetches nothing", async () => {
    const { root, store, upstream, env } = host()
    await upstreamRepository(upstream, "child", env)
    const url = `${HOSTED}child.git`
    const created = await refreshMirror({ root: store, url, gitIn: through(env) })
    const held = tryAcquireFlock(`${created.path}.lock`)
    expect(held).not.toBeNull()
    try {
      const counted = traced(env, root)
      const refused = refreshMirror({ root: store, url, gitIn: through(counted.env), lockWaitMs: 300 })
      await expect(refused).rejects.toBeInstanceOf(MirrorUnavailable)
      await expect(refused).rejects.toThrow(`${created.path}.lock`)
      expect(readRemoteCalls(counted.dir).verbs.fetch ?? 0).toBe(0)
    } finally {
      held?.release()
    }
  })

  it("refuses by URL when the repository cannot be cloned, and leaves no store behind", async () => {
    const { store, env } = host()
    const url = `${HOSTED}absent.git`
    const refused = refreshMirror({ root: store, url, gitIn: through(env) })
    await expect(refused).rejects.toBeInstanceOf(MirrorUnavailable)
    await expect(refused).rejects.toThrow(url)
    const owner = join(store, "github.com", "beorn")
    expect(existsSync(owner) ? readdirSync(owner).filter((name) => !name.endsWith(".lock")) : []).toEqual([])
  })

  it("refuses a URL that names no hosted repository instead of guessing a path", async () => {
    const { store, env } = host()
    await expect(refreshMirror({ root: store, url: "/srv/git/yrd.git", gitIn: through(env) })).rejects.toThrow(
      "/srv/git/yrd.git names no hosted repository",
    )
  })
})

describe("refreshDeclaredMirrors", () => {
  it("mirrors every hosted repository the commit declares, nested ones included, and names each one it skips", async () => {
    const { root, store, upstream, env } = host()
    const leaf = await upstreamRepository(upstream, "leaf", env)
    const middle = await upstreamRepository(upstream, "middle", env)
    const middleAt = await declare(middle, env, [
      { path: "apps/leaf", url: `${HOSTED}leaf.git`, sha: await head(leaf, env) },
    ])
    const sibling = await upstreamRepository(upstream, "sibling", env)
    const local = await upstreamRepository(join(root, "elsewhere"), "local", env)
    const product = await upstreamRepository(upstream, "product", env)
    const commit = await declare(product, env, [
      { path: "vendor/middle", url: `${HOSTED}middle.git`, sha: middleAt },
      { path: "vendor/sibling", url: `${HOSTED}sibling.git`, sha: await head(sibling, env) },
      { path: "vendor/again", url: "ssh://git@github.com/beorn/sibling.git", sha: await head(sibling, env) },
      { path: "vendor/local", url: join(root, "elsewhere", "local.git"), sha: await head(local, env) },
    ])

    const result = await refreshDeclaredMirrors({ root: store, repo: product, commits: [commit], gitIn: through(env) })
    expect(result.refreshed.map(({ path }) => path.slice(store.length + 1)).sort()).toEqual([
      "github.com/beorn/leaf.git",
      "github.com/beorn/middle.git",
      "github.com/beorn/sibling.git",
    ])
    expect(result.skipped).toEqual([
      {
        path: "vendor/local",
        url: join(root, "elsewhere", "local.git"),
        reason: `${join(root, "elsewhere", "local.git")} names no hosted repository`,
      },
    ])
  })

  it("names a nested level it could not read when the mirror lacks the declared gitlink", async () => {
    const { store, upstream, env } = host()
    const middle = await upstreamRepository(upstream, "middle", env)
    const unpushed = await head(middle, env)
    const product = await upstreamRepository(upstream, "product", env)
    const git = gitIn(middle, undefined, undefined, { env })
    writeFileSync(join(middle, "local-only.txt"), "never pushed\n")
    await git(["add", "--all"])
    await git([...author, "commit", "--quiet", "--message", "local only"])
    const neverPushed = await head(middle, env)
    expect(neverPushed).not.toBe(unpushed)
    const commit = await declare(product, env, [
      { path: "vendor/middle", url: `${HOSTED}middle.git`, sha: neverPushed },
    ])

    const result = await refreshDeclaredMirrors({ root: store, repo: product, commits: [commit], gitIn: through(env) })
    expect(result.refreshed.map(({ url }) => url)).toEqual([`${HOSTED}middle.git`])
    expect(result.skipped).toEqual([
      {
        path: "vendor/middle",
        url: `${HOSTED}middle.git`,
        reason: `the mirror holds no ${neverPushed}, so the submodules it declares were not read`,
      },
    ])
  })
})

describe("composeEnvironment", () => {
  it("W1: routes a mirrored owner's fetches to the store and keeps its pushes on the hosted URL", async () => {
    const { root, store, upstream, env } = host()
    const leaf = await upstreamRepository(upstream, "leaf", env)
    const product = await upstreamRepository(upstream, "product", env)
    const commit = await declare(product, env, [
      { path: "vendor/leaf", url: `${HOSTED}leaf.git`, sha: await head(leaf, env) },
    ])
    const { refreshed } = await refreshDeclaredMirrors({ root: store, repo: product, commits: [commit], gitIn: through(env) })
    // The compose env is layered over a caller env that has NO test rewrite, as on the host.
    const plain = { ...process.env, GIT_SSH_COMMAND: "false", GIT_CONFIG_COUNT: "0" }
    const composing = composeEnvironment(plain, store, refreshed)
    const clone = join(root, "composed")
    await gitIn(root, undefined, undefined, { env: composing })(["clone", "--quiet", `${HOSTED}leaf.git`, clone])
    const child = gitIn(clone, undefined, undefined, { env: composing })
    expect((await child(["config", "--get", "remote.origin.url"])).trim()).toBe(`${HOSTED}leaf.git`)
    expect((await child(["remote", "get-url", "origin"])).trim()).toBe(
      `file://${join(store, "github.com", "beorn")}/leaf.git`,
    )
    expect((await child(["remote", "get-url", "--push", "origin"])).trim()).toBe(`${HOSTED}leaf.git`)
    // Without the compose env the same clone names GitHub again: nothing was written into its config.
    const outside = gitIn(clone, undefined, undefined, { env: plain })
    expect((await outside(["remote", "get-url", "origin"])).trim()).toBe(`${HOSTED}leaf.git`)
  })

  it("adds nothing when nothing was mirrored, so a compose without a store reads exactly as before", () => {
    const env = { PATH: "/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" }
    expect(composeEnvironment(env, "/store", [])).toEqual(env)
  })
})

// Both rows are review-adhoc5's, from the review of slice 1 (2d36b8bbde): P1 found that the stamp promised more than
// the fetch had read; P2 pins the once-per-repository guard, which no row reddened before.
describe("what a refresh promises", () => {
  it("a refresh asked after a push, while another is mid-fetch, returns holding that push", async () => {
    const { store, upstream, env } = host()
    const work = await upstreamRepository(upstream, "child", env)
    const url = `${HOSTED}child.git`
    await refreshMirror({ root: store, url, gitIn: through(env) })
    const git = gitIn(work, undefined, undefined, { env })
    let pushed = ""
    let late: Promise<MirrorRefresh> | undefined
    // The first refresh's fetch takes its advertisement, THEN the remote moves and the second caller asks,
    // while the first still holds the lock (a slow pack transfer, modelled as a wait after the fetch).
    const slow = (cwd: string): Git => {
      const inner = gitIn(cwd, undefined, undefined, { env })
      return async (args, input) => {
        const out = await inner(args, input)
        if (args[0] === "fetch" && late === undefined) {
          writeFileSync(join(work, "late.txt"), "late\n")
          await git(["add", "--all"])
          await git([...author, "commit", "--quiet", "--message", "late"])
          await git(["push", "--quiet", "origin", "main"])
          pushed = (await git(["rev-parse", "HEAD"])).trim()
          late = refreshMirror({ root: store, url, gitIn: through(env) })
          await sleep(400)
        }
        return out
      }
    }
    const first = await refreshMirror({ root: store, url, gitIn: slow })
    expect(late).toBeDefined()
    const second = await (late as Promise<MirrorRefresh>)
    expect(second.outcome).toBe("fetched")
    const mirror = gitIn(first.path, undefined, undefined, { env })
    expect((await mirror(["rev-parse", "refs/heads/main"])).trim()).toBe(pushed)
  })

  it("one repository declared at two paths is contacted once", async () => {
    const { root, store, upstream, env } = host()
    const sibling = await upstreamRepository(upstream, "sibling", env)
    const product = await upstreamRepository(upstream, "product", env)
    const sha = await head(sibling, env)
    const commit = await declare(product, env, [
      { path: "vendor/sibling", url: `${HOSTED}sibling.git`, sha },
      { path: "vendor/again", url: "ssh://git@github.com/beorn/sibling.git", sha },
    ])
    const counted = traced(env, root)
    await refreshDeclaredMirrors({ root: store, repo: product, commits: [commit], gitIn: through(counted.env) })
    const verbs = readRemoteCalls(counted.dir).verbs
    expect({ clone: verbs.clone ?? 0, fetch: verbs.fetch ?? 0 }).toEqual({ clone: 1, fetch: 0 })
  })
})
