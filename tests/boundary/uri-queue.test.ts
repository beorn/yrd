/**
 * @failure A host-started queue accepts a URI but borrows the caller's checkout,
 * creates a clone at a non-canonical path, or cannot merge from its owned clone.
 * @level l3 (real CLI process, bare remote, submit, clone and merge)
 * @consumer Hab starting a queue service on a machine with no checkout.
 * @reach fs-walk <fixture-only: real Git commands traverse temporary repositories and workdir>
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parseQueueAddress, queueDirectory } from "../../packages/yrd-cli/src/address.ts"
import { git } from "./fixture.ts"
import { installSelectedGit } from "../../packages/yrd-cli/tests/support/selected-git.ts"
import { birthEventQueue } from "../../packages/yrd-cli/tests/support/event-queue-birth.ts"
import { gitIn, resolveGitSelection } from "../../packages/yrd-queue-core/src/git.ts"
import { publishMovedGitlinks } from "../../packages/yrd-queue-core/src/submit.ts"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const roots: string[] = []
const gitSuperBin = resolve(Bun.resolveSync("git-super", import.meta.dirname), "../../bin")

function gitSubcommand(args: readonly string[]): Readonly<{ name: string; tail: readonly string[] }> | undefined {
  const withValue = new Set(["--git-dir", "--work-tree", "--namespace", "--config-env", "-C", "-c"])
  const alone = new Set([
    "--bare",
    "--no-pager",
    "--paginate",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-replace-objects",
    "--no-lazy-fetch",
  ])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (withValue.has(arg)) {
      index++
      continue
    }
    if (alone.has(arg) || /^(?:--git-dir|--work-tree|--namespace|--config-env)=/u.test(arg)) continue
    if (arg.startsWith("-")) return undefined
    return { name: arg, tail: args.slice(index + 1) }
  }
  return undefined
}

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

describe("a queue started by address on a host with no checkout", () => {
  it("run owns its canonical clone and merges an admitted change", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-uri-queue-"))
    roots.push(root)
    const remote = join(root, "remote.git")
    const author = join(root, "author")
    const outside = join(root, "outside")
    const workdir = join(root, "state", "yrd")
    mkdirSync(outside)

    await git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote)
    await git(root, "clone", "--quiet", remote, author)
    await git(author, "config", "user.name", "queue author")
    await git(author, "config", "user.email", "author@example.invalid")
    await git(author, "checkout", "--quiet", "-b", "main")
    const delivered = join(root, "delivered.jsonl")
    writeFileSync(join(author, "notify.sh"), `test -f .ready || exit 41\ncat >> '${delivered}'\n`)
    writeFileSync(
      join(author, ".yrd.yml"),
      'setup: "printf ready > .ready"\nnotify: [{first: {on: [merged], run: "sh notify.sh"}}, {second: {on: [merged], run: "sh notify.sh"}}]\n',
    )
    await git(author, "add", ".yrd.yml", "notify.sh")
    await git(author, "commit", "--quiet", "-m", "declare main queue")
    await git(author, "push", "--quiet", "origin", "main")
    await birthEventQueue(author, "main", { localStore: false })
    await git(author, "checkout", "--quiet", "-b", "task/uri")
    writeFileSync(join(author, "change.txt"), "from uri\n")
    writeFileSync(join(author, "notify.sh"), "exit 42\n")
    await git(author, "add", "change.txt", "notify.sh")
    await git(author, "commit", "--quiet", "-m", "change from uri")

    // T1: the selected executable must own URI resolution and clone creation,
    // before the queue core runs. Native-only outcomes missed that early escape.
    const selected = await installSelectedGit(author)
    const selectionConfig = join(root, "selected.gitconfig")
    await git(
      root,
      "config",
      "--file",
      selectionConfig,
      "yrd.git",
      JSON.stringify({ executable: selected.executable, contract: "native" }),
    )

    await git(root, "config", "--file", selectionConfig, "user.name", "URI Queue Test")
    await git(root, "config", "--file", selectionConfig, "user.email", "uri-queue@example.invalid")

    // 25196: env list is an owning-repository read. A native Git fallback
    // returns plausible rows, so only the selected executable's call log
    // distinguishes the correct path from the unselected one.
    const beforeEnvList = selected.readCalls().length
    const envList = Bun.spawn(["bun", join(REPO_ROOT, "bin/yrd.ts"), "env", "list", "--json"], {
      cwd: author,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: selectionConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "yrd.workdir",
        GIT_CONFIG_VALUE_0: workdir,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [envListOut, envListErr, envListExit] = await Promise.all([
      new Response(envList.stdout).text(),
      new Response(envList.stderr).text(),
      envList.exited,
    ])
    expect(envListExit, `${envListErr}\n${envListOut}`).toBe(0)
    expect(
      selected
        .readCalls()
        .slice(beforeEnvList)
        .some(({ cwd, args }) => cwd === author && args[0] === "worktree"),
    ).toBe(true)

    // Mirror refresh has a separate CLI entry and injects runners for each
    // repository it visits. Its owning-repo reads use the chosen executable.
    await git(author, "config", "yrd.mirror", join(root, "mirrors"))
    const beforeMirror = selected.readCalls().length
    const mirror = Bun.spawn(["bun", join(REPO_ROOT, "bin/yrd.ts"), "mirror", "refresh", "--json"], {
      cwd: author,
      env: { ...process.env, GIT_CONFIG_GLOBAL: selectionConfig },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [mirrorOut, mirrorErr, mirrorExit] = await Promise.all([
      new Response(mirror.stdout).text(),
      new Response(mirror.stderr).text(),
      mirror.exited,
    ])
    expect(mirrorExit, `${mirrorErr}\n${mirrorOut}`).toBe(0)
    expect(
      selected
        .readCalls()
        .slice(beforeMirror)
        .some(({ cwd, args }) => cwd === author && args[0] === "config"),
    ).toBe(true)
    expect(
      selected
        .readCalls()
        .slice(beforeMirror)
        .some(({ cwd, args }) => cwd === author && args[0] === "ls-tree"),
    ).toBe(true)

    const submit = Bun.spawn(
      ["bun", join(REPO_ROOT, "bin/yrd.ts"), "submit", "task/uri", "--queue", "main", "--notify", "@dev/3", "--json"],
      {
        cwd: author,
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [submitStdout, submitStderr, submitExit] = await Promise.all([
      new Response(submit.stdout).text(),
      new Response(submit.stderr).text(),
      submit.exited,
    ])
    expect(submitExit, `${submitStderr}\n${submitStdout}`).toBe(0)
    expect(await git(remote, "for-each-ref", "--format=%(refname)", "refs/yrd/main/")).toContain(
      "refs/yrd/main/changes/task/uri",
    )

    const address = `${remote}#main`
    for (const verb of ["pause", "resume"]) {
      const transition = Bun.spawn(
        [
          "bun",
          join(REPO_ROOT, "bin/yrd.ts"),
          "queue",
          verb,
          "--queue",
          address,
          ...(verb === "pause" ? ["--reason", "inspect admitted change"] : []),
          "--json",
        ],
        {
          cwd: outside,
          env: {
            ...process.env,
            PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
            GIT_CONFIG_GLOBAL: selectionConfig,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "yrd.workdir",
            GIT_CONFIG_VALUE_0: workdir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(transition.stdout).text(),
        new Response(transition.stderr).text(),
        transition.exited,
      ])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ kind: verb === "pause" ? "paused" : "resumed" })
    }
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "bin/yrd.ts"), "queue", "run", "--queue", address, "--json"], {
      cwd: outside,
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
        GIT_CONFIG_GLOBAL: selectionConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "yrd.workdir",
        GIT_CONFIG_VALUE_0: workdir,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    const result = JSON.parse(stdout) as { exitCode: number; merged: string[]; log: string }
    expect(exitCode, `${stderr}\n${stdout}\n${readFileSync(result.log, "utf8")}`).toBe(0)
    const owned = queueDirectory(workdir, parseQueueAddress(address))
    expect(existsSync(owned)).toBe(true)
    const selectedCalls = selected.readCalls()
    expect(selectedCalls.some(({ cwd, args }) => cwd === dirname(owned) && args[0] === "clone")).toBe(true)
    expect(selectedCalls.some(({ cwd, args }) => cwd === owned && args[0] === "remote")).toBe(true)
    // Gitomic places global options before the subcommand. The selected
    // executable still owns the one atomic, leased author publication.
    const authorPush = selectedCalls
      .filter(({ cwd }) => cwd === author)
      .map(({ args }) => gitSubcommand(args))
      .find((call) => call?.name === "push")
    expect(authorPush, "selected author Git saw no push verb").toBeDefined()
    expect(authorPush?.tail).toContain("--atomic")
    // Three leases in one atomic event push: task branch, change chain, and
    // queue tip. The queue tip fences intake against a racing maintenance event.
    const leases = authorPush?.tail.filter((arg) => arg.startsWith("--force-with-lease=")) ?? []
    expect(leases).toHaveLength(3)
    expect(leases.some((arg) => arg.startsWith("--force-with-lease=refs/yrd/main/queue:"))).toBe(true)
    expect(
      selectedCalls.some(
        ({ cwd, args }) =>
          cwd === author &&
          args[0] === "--git-dir" &&
          gitSubcommand(args)?.name === "fetch" &&
          args.some((arg) => arg.includes("refs/heads/main")),
      ),
    ).toBe(true)
    expect(result, `${stderr}\n${readFileSync(result.log, "utf8")}`).toMatchObject({
      exitCode: 0,
      merged: ["task/uri"],
    })
    const receipts = readFileSync(delivered, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) expect(receipt).toMatchObject({ record: "merged" })
    expect(existsSync(join(owned, "notify.sh"))).toBe(false)
    expect((await git(owned, "worktree", "list", "--porcelain")).match(/^worktree /gmu)).toHaveLength(1)
    const target = await git(remote, "rev-parse", "refs/heads/main")
    expect((await git(remote, "rev-list", "--parents", "-n", "1", target)).split(" ")).toHaveLength(3)

    // An event queue read must use the selected executable for its remote
    // fetch after the target moves.
    await git(author, "checkout", "--quiet", "main")
    await git(author, "pull", "--quiet", "--ff-only", "origin", "main")
    writeFileSync(join(author, ".yrd.yml"), "{}\n")
    await git(author, "add", ".yrd.yml")
    await git(author, "commit", "--quiet", "-m", "declare event queue")
    await git(author, "push", "--quiet", "origin", "main")
    const beforeEventRead = selected.readCalls().length
    const listing = Bun.spawn(["bun", join(REPO_ROOT, "bin/yrd.ts"), "queue", "list", "--queue", address, "--json"], {
      cwd: owned,
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
        GIT_CONFIG_GLOBAL: selectionConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "yrd.workdir",
        GIT_CONFIG_VALUE_0: workdir,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [listOut, listErr, listExit] = await Promise.all([
      new Response(listing.stdout).text(),
      new Response(listing.stderr).text(),
      listing.exited,
    ])
    expect(listExit, `${listErr}\n${listOut}`).toBe(0)
    const eventReads = selected.readCalls().slice(beforeEventRead)
    expect(
      eventReads.some(
        ({ cwd, args }) =>
          cwd === owned && gitSubcommand(args)?.name === "fetch" && args.some((arg) => arg.includes("refs/yrd/main/*")),
      ),
      JSON.stringify(eventReads.filter(({ args }) => gitSubcommand(args)?.name === "fetch").map(({ args }) => args)),
    ).toBe(true)

    // Both terminal verbs inspect candidate refs after writing their event.
    // Those reads create a second runner from the event store's repository.
    for (const terminal of ["withdraw", "drop"] as const) {
      const branch = `task/${terminal}`
      await git(author, "checkout", "--quiet", "main")
      await git(author, "checkout", "--quiet", "-b", branch)
      writeFileSync(join(author, `${terminal}.txt`), `${terminal}\n`)
      await git(author, "add", `${terminal}.txt`)
      await git(author, "commit", "--quiet", "-m", `${terminal} candidate`)
      for (const command of [
        ["submit", branch, "--queue", "main", "--notify", "@dev/3", "--json"],
        [terminal, branch, "--queue", "main", "--notify", "@dev/3", "--json"],
      ]) {
        const before = selected.readCalls().length
        const invoked = Bun.spawn(["bun", join(REPO_ROOT, "bin/yrd.ts"), ...command], {
          cwd: author,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: selectionConfig,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "yrd.workdir",
            GIT_CONFIG_VALUE_0: workdir,
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [out, err, code] = await Promise.all([
          new Response(invoked.stdout).text(),
          new Response(invoked.stderr).text(),
          invoked.exited,
        ])
        expect(code, `${command.join(" ")}: ${err}\n${out}`).toBe(0)
        if (command[0] === terminal) {
          expect(
            selected
              .readCalls()
              .slice(before)
              .some(
                ({ cwd, args }) =>
                  cwd === owned &&
                  gitSubcommand(args)?.name === "ls-remote" &&
                  args.some((arg) => arg.startsWith("refs/yrd/candidates/")),
              ),
            `${terminal} did not inspect candidate refs with selected Git`,
          ).toBe(true)
        }
      }
    }
  }, 120_000)
})

describe("a changed gitlink published by the submitter", () => {
  it("uses the root's selected Git executable in the child checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-selected-gitlink-"))
    roots.push(root)
    const childRemote = join(root, "child.git")
    const childSeed = join(root, "child-seed")
    const superproject = join(root, "super")
    await git(root, "init", "--quiet", "--bare", "--initial-branch=main", childRemote)
    await git(root, "clone", "--quiet", childRemote, childSeed)
    await git(childSeed, "config", "user.name", "Selected Git Test")
    await git(childSeed, "config", "user.email", "selected-git@example.invalid")
    await git(childSeed, "checkout", "--quiet", "-b", "main")
    writeFileSync(join(childSeed, "child.txt"), "base\n")
    await git(childSeed, "add", "child.txt")
    await git(childSeed, "commit", "--quiet", "-m", "child base")
    await git(childSeed, "push", "--quiet", "origin", "main")

    await git(root, "init", "--quiet", "--initial-branch=main", superproject)
    await git(superproject, "config", "user.name", "Selected Git Test")
    await git(superproject, "config", "user.email", "selected-git@example.invalid")
    await git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", childRemote, "child")
    await git(superproject, "commit", "--quiet", "-am", "root base")
    const base = (await git(superproject, "rev-parse", "HEAD")).trim()
    const child = join(superproject, "child")
    await git(child, "config", "user.name", "Selected Git Test")
    await git(child, "config", "user.email", "selected-git@example.invalid")
    writeFileSync(join(child, "child.txt"), "changed\n")
    await git(child, "commit", "--quiet", "-am", "child change")
    const pin = (await git(child, "rev-parse", "HEAD")).trim()
    await git(superproject, "add", "child")
    await git(superproject, "commit", "--quiet", "-m", "move child pin")
    const head = (await git(superproject, "rev-parse", "HEAD")).trim()

    const selected = await installSelectedGit(superproject)
    const rootGit = gitIn(superproject, undefined, await resolveGitSelection(superproject))
    const published = await publishMovedGitlinks(rootGit, superproject, base, head)
    expect(published).toMatchObject([{ path: "child", sha: pin, state: "published" }])
    expect(selected.readCalls().some(({ cwd, args }) => cwd === child && args[0] === "remote")).toBe(true)
    expect(
      selected.readCalls().some(({ cwd, args }) => cwd === child && args[0] === "push" && args.includes("origin")),
    ).toBe(true)
  }, 30_000)
})
