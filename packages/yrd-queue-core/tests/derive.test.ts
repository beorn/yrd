/**
 * `derive:` (27176): the queue's compose regenerates a file whose inputs are the merged gitlinks, inside the merge,
 * and the candidate that leaves is still one two-parent merge whose submodule pin is the derived commit.
 *
 * @failure An author regenerates a derived file against gitlinks the merge has not decided, and two honest changes
 * conflict on it; or the queue's regeneration leaves the candidate without a frozen publication intent.
 * @level l2
 * @consumer the event queue's compose step (event-run.ts) through verifyCandidate
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"
import { testGitIn as rawGitIn } from "../../../tests/support/test-git-in.ts"
import { DeriveFailed } from "../src/derive.ts"
import { verifyCandidate } from "../src/verifying.ts"
import type { Git } from "../src/git.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

type World = Readonly<{
  root: string
  work: string
  git: Git
  childRemote: string
  target: string
  head: string
  env: NodeJS.ProcessEnv
}>

const ROOT_URL = "https://github.com/example/derive-root.git"
const LIB_URL = "https://github.com/example/derive-lib.git"

/** git-super freezes a push intent only for hosted remotes: the fixture names GitHub-shaped URLs and rewrites them to the local bare repositories. */
function hostedEnv(rootRemote: string, childRemote: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.${rootRemote}.insteadOf`,
    GIT_CONFIG_VALUE_1: ROOT_URL,
    GIT_CONFIG_KEY_2: `url.${childRemote}.insteadOf`,
    GIT_CONFIG_VALUE_2: LIB_URL,
  }
}

/**
 * A root with one submodule `lib`, both with bare remotes; `main` pins lib at L1 and the change `task/bump` pins it
 * at L2 (a commit on lib's main). `lib/derived.txt` is the file a derive regenerates from the pin.
 */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-derive-"))
  roots.push(root)
  const rootRemote = join(root, "root.git")
  const childRemote = join(root, "lib.git")
  const env = hostedEnv(rootRemote, childRemote)
  const gitIn = (cwd: string) => rawGitIn(cwd, undefined, undefined, { env })
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", rootRemote])
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", childRemote])
  const libWork = join(root, "lib-work")
  await seed(["clone", "--quiet", LIB_URL, libWork])
  const lib = gitIn(libWork)
  await lib(["config", "user.email", "lib@yrd.test"])
  await lib(["config", "user.name", "lib"])
  await lib(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(libWork, "lib.txt"), "one\n")
  writeFileSync(join(libWork, "derived.txt"), "derived-from: (none)\n")
  await lib(["add", "-A"])
  await lib(["commit", "--quiet", "-m", "lib one"])
  await lib(["push", "--quiet", "origin", "main"])
  const l1 = (await lib(["rev-parse", "HEAD"])).trim()

  const work = join(root, "work")
  await seed(["clone", "--quiet", ROOT_URL, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "target.txt"), "base\n")
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["submodule", "add", "--quiet", LIB_URL, "lib"])
  await git(["add", "-A"])
  await git(["commit", "--quiet", "-m", "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()

  // lib moves on its main; the change records the new pin.
  writeFileSync(join(libWork, "lib.txt"), "two\n")
  await lib(["commit", "--quiet", "-am", "lib two"])
  await lib(["push", "--quiet", "origin", "main"])
  const l2 = (await lib(["rev-parse", "HEAD"])).trim()
  expect(l2).not.toBe(l1)
  await git(["checkout", "--quiet", "-b", "task/bump", "main"])
  await gitIn(join(work, "lib"))(["fetch", "--quiet", "origin"])
  await gitIn(join(work, "lib"))(["checkout", "--quiet", l2])
  await git(["add", "lib"])
  await git(["commit", "--quiet", "-m", "bump lib"])
  await git(["push", "--quiet", "origin", "task/bump"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  return { root, work, git, childRemote, target, head, env }
}

/**
 * A derive that writes lib/derived.txt from lib's CONTENT (lib.txt at the settled pin) and prints its subject. It is
 * a function of the merged gitlinks: run again on the derived candidate it writes the same bytes. (A derive that
 * copied the pin of the submodule it writes into would never be — the compose's second run catches that.)
 */
function deriveScript(root: string, variant: "ok" | "root" | "fail" = "ok"): string {
  const script = join(root, `derive-${variant}.sh`)
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -e",
      'pin=$(git -C "$YRD_REPO/lib" show HEAD:lib.txt)',
      variant === "fail" ? 'echo "derive broke on purpose" >&2; exit 7' : "",
      'printf "derived-from: %s\\n" "$pin" > "$YRD_REPO/lib/derived.txt"',
      variant === "root" ? 'printf "root\\n" > "$YRD_REPO/root-derived.txt"' : "",
      'echo "chore(lib): derived.txt follows lib ${pin}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return script
}

async function compose(w: World, run: string | undefined, path: string) {
  const logDir = join(w.root, "logs", path)
  mkdirSync(logDir, { recursive: true })
  return verifyCandidate({
    git: w.git,
    env: w.env,
    repo: w.work,
    targetHead: w.target,
    head: w.head,
    path: join(w.root, "candidates", path),
    message: "merge task/bump into main\n\nChange: task/bump\nMerged-By: yrd",
    noFetch: true,
    // As the queue runs it: the derived child objects are adopted into the queue clone's stores before the
    // worktree goes, which is where publication reads them.
    worktree: { env: w.env, populateReference: true },
    ...(run === undefined ? {} : { derive: { run, logDir, tmpdir: join(w.root, "tmp") } }),
  })
}

describe("derive: the compose regenerates what the merged gitlinks decide", () => {
  it("commits the regenerated file on the settled pin and composes it in as a two-parent merge", async () => {
    const w = await world()
    const verified = await compose(w, deriveScript(w.root), "ok")
    if (verified.state !== "verified") throw new Error(`compose failed: ${verified.verifying.detail.message}`)
    const { candidate, derived } = verified.verifying
    expect(derived).toBeDefined()
    if (derived === undefined) throw new Error("no derivation recorded")
    const parents = (await w.git(["show", "-s", "--format=%P", candidate])).trim().split(" ")
    expect(parents).toHaveLength(2)
    expect(parents[0]).toBe(derived.composed)
    expect(parents[1]).toBe(derived.carrier)
    const pin = (await w.git(["rev-parse", `${candidate}:lib`])).trim()
    expect(derived.submodules).toEqual([{ path: "lib", from: expect.any(String), to: pin }])
    const l2 = (await w.git(["rev-parse", `${w.head}:lib`])).trim()
    expect(derived.submodules[0]?.from).toBe(l2)
    const lib = rawGitIn(join(w.work, "lib"), undefined, undefined, { env: w.env })
    expect((await lib(["show", "-s", "--format=%s", pin])).trim()).toBe("chore(lib): derived.txt follows lib two")
    expect(derived.subject).toBe("chore(lib): derived.txt follows lib two")
    expect((await lib(["show", `${pin}:derived.txt`])).trim()).toBe("derived-from: two")
    expect((await lib(["show", "-s", "--format=%P", pin])).trim()).toBe(l2)
    // The candidate's message keeps the change's trailers and says what it is.
    const message = await w.git(["show", "-s", "--format=%B", candidate])
    expect(message).toContain("derived into")
    expect(message).toContain("Change: task/bump")
    expect(message).toMatch(/Git-Super-Push:/u)
    // The pin is reachable from the queue clone, where publication reads it.
    await lib(["cat-file", "-e", `${pin}^{commit}`])
  })

  it("leaves the plain merge alone when the command changes nothing", async () => {
    const w = await world()
    const noop = join(w.root, "noop.sh")
    writeFileSync(noop, "#!/bin/sh\necho nothing to derive\n", { mode: 0o755 })
    const verified = await compose(w, noop, "noop")
    if (verified.state !== "verified") throw new Error(`compose failed: ${verified.verifying.detail.message}`)
    expect(verified.verifying.derived).toBeUndefined()
    const parents = (await w.git(["show", "-s", "--format=%P", verified.verifying.candidate])).trim().split(" ")
    expect(parents).toEqual([w.target, w.head])
    const plain = await compose(w, undefined, "plain")
    if (plain.state !== "verified") throw new Error("plain compose failed")
    expect((await w.git(["rev-parse", `${plain.verifying.candidate}:lib`])).trim()).toBe(
      (await w.git(["rev-parse", `${verified.verifying.candidate}:lib`])).trim(),
    )
  })

  it("a change outside every submodule stops the compose by name and says root derivation is not admitted", async () => {
    const w = await world()
    await expect(compose(w, deriveScript(w.root, "root"), "root")).rejects.toThrow(
      /root-derived\.txt outside every submodule; root derivation is not admitted yet/u,
    )
  })

  it("a failing command stops the compose with its exit and log, never a candidate", async () => {
    const w = await world()
    const failure = await compose(w, deriveScript(w.root, "fail"), "fail").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeriveFailed)
    if (!(failure instanceof DeriveFailed)) throw new Error("expected DeriveFailed")
    expect(failure.message).toMatch(/exit 7/u)
    expect(failure.message).toMatch(/log /u)
    const log = /log (\S+)/u.exec(failure.message)?.[1]
    expect(log).toBeDefined()
    expect(readFileSync(log as string, "utf8")).toContain("derive broke on purpose")
  })
})
