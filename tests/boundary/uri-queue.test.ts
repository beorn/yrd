/**
 * @failure A host-started queue accepts a URI but borrows the caller's checkout,
 * creates a clone at a non-canonical path, or cannot merge from its owned clone.
 * @level l3 (real CLI process, bare remote, submit, clone and merge)
 * @consumer Hab starting a queue service on a machine with no checkout.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parseQueueAddress, queueDirectory } from "../../packages/yrd-cli/src/address.ts"
import { git } from "./fixture.ts"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

describe("a queue started by address on a host with no checkout", () => {
  it("run owns its canonical clone and merges an admitted change", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd uri queue "))
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
    writeFileSync(join(author, ".yrd.yml"), 'checks:\n  - verify:\n      run: "exit 2"\n')
    await git(author, "add", ".yrd.yml")
    await git(author, "commit", "--quiet", "-m", "declare main queue")
    await git(author, "push", "--quiet", "origin", "main")
    await git(author, "checkout", "--quiet", "-b", "task/uri")
    writeFileSync(join(author, "change.txt"), "from uri\n")
    await git(author, "add", "change.txt")
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

    expect(exitCode, stderr).toBe(2)
    const failed = JSON.parse(stdout) as { exitCode: number; stuck: string[]; log: string }
    expect(failed).toMatchObject({ exitCode: 2, stuck: ["task/uri"] })
    const changeRef = (await git(remote, "for-each-ref", "--format=%(refname)", "refs/yrd/main/"))
      .split("\n")
      .find((ref) => ref.includes("/task/uri@"))
    if (changeRef === undefined) throw new Error("refs/yrd/main/ has no admitted task/uri change after the failed run")
    const next = (await git(remote, "log", "-1", "--format=%(trailers:key=Next,valueonly)", changeRef)).trim()
    expect(next).toContain("yrd queue run")

    await git(author, "checkout", "--quiet", "main")
    writeFileSync(join(author, ".yrd.yml"), "{}\n")
    await git(author, "add", ".yrd.yml")
    await git(author, "commit", "--quiet", "-m", "repair queue declaration")
    await git(author, "push", "--quiet", "origin", "main")
    const command = next.match(/yrd queue run.*$/u)?.[0]
    if (command === undefined) throw new Error(`the admitted change's Next trailer has no retry command: ${next}`)
    const retry = command.replace(/^yrd queue run/u, `bun ${Bun.$.escape(join(REPO_ROOT, "bin/yrd.ts"))} queue run`)
    const rerun = Bun.spawn(["sh", "-c", retry], {
      cwd: outside,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "yrd.workdir",
        GIT_CONFIG_VALUE_0: workdir,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [retryStdout, retryStderr, retryExit] = await Promise.all([
      new Response(rerun.stdout).text(),
      new Response(rerun.stderr).text(),
      rerun.exited,
    ])
    expect(retryExit, `${retryStderr}\n${retryStdout}`).toBe(0)
    expect(retryStdout).toContain("merged")
    const owned = queueDirectory(workdir, parseQueueAddress(address))
    expect(existsSync(owned)).toBe(true)
    expect(await git(remote, "show", "refs/heads/main:change.txt")).toBe("from uri")
    const target = await git(remote, "rev-parse", "refs/heads/main")
    expect((await git(remote, "rev-list", "--parents", "-n", "1", target)).split(" ")).toHaveLength(3)
  }, 120_000)
})
