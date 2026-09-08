/**
 * @failure A host-started queue accepts a URI but borrows the caller's checkout,
 * creates a clone at a non-canonical path, or cannot merge from its owned clone.
 * @level l3 (real CLI process, bare remote, submit, clone and merge)
 * @consumer Hab starting a queue service on a machine with no checkout.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parseQueueAddress, queueDirectory } from "../../packages/yrd-cli/src/address.ts"
import { git } from "./fixture.ts"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const roots: string[] = []
const gitSuperBin = resolve(Bun.resolveSync("git-super", import.meta.dirname), "../../bin")

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
    await git(author, "checkout", "--quiet", "-b", "task/uri")
    writeFileSync(join(author, "change.txt"), "from uri\n")
    writeFileSync(join(author, "notify.sh"), "exit 42\n")
    await git(author, "add", "change.txt", "notify.sh")
    await git(author, "commit", "--quiet", "-m", "change from uri")

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
      "refs/yrd/main/task/uri@",
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
  }, 120_000)
})
