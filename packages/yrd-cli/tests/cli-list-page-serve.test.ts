/**
 * @failure  #38182: a host that reads a source every few seconds spawns yrd → the declared provider → km for every
 *           page, so each read pays process start plus a vault open (586 ms measured on /hh/pm). `list-page-serve`
 *           is the declared long-lived form: yrd resolves the declaration and the pin once, hands the provider this
 *           process's stdio, and stays its parent. If yrd parsed or rewrote a frame, the protocol would have a
 *           second contract; this test pins that bytes pass through untouched and that the provider's exit is yrd's.
 * @level    l2 — a real git repository on main with a real issues.yml, yrd run as a real child process
 * @consumer #38182 km page-serve through a declared yrd verb (hightea's km source)
 * @testonly none
 */
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const YRD = fileURLToPath(new URL("../../../bin/yrd", import.meta.url))

/** A repository whose main declares a long-lived reader that echoes each frame back unchanged. */
function projectWithServe(): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-page-serve-"))
  roots.push(root)
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@t.t")
  git("config", "user.name", "t")
  const echo = `process.stdin.pipe(process.stdout)`
  writeFileSync(
    join(root, "issues.yml"),
    `list-page-serve: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify(echo)}]\n`,
  )
  git("add", "issues.yml")
  git("commit", "-q", "-m", "declare a long-lived reader")
  return root
}

describe("list-page-serve: a declared reader runs with this process's stdio", () => {
  it("passes every frame through untouched and answers with the provider's exit code", async () => {
    const root = projectWithServe()
    const child = spawn(process.execPath, [YRD, "issues", "list-page-serve", "--project-root", root], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const lines = createInterface({ input: child.stdout })
    const seen: string[] = []
    lines.on("line", (line) => seen.push(line))
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const frame = '{"seq":1,"request":{"binding":"b","population":"p","generation":"g","limit":1}}'
    child.stdin.write(`${frame}\n`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no echo; stderr: ${stderr}`)), 20_000)
      lines.once("line", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    child.stdin.end()
    const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)))
    expect(seen[0]).toBe(frame)
    expect(exitCode).toBe(0)
  }, 60_000)

  it("refuses by name when the project does not declare the verb", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-cli-page-serve-absent-"))
    roots.push(root)
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t.t")
    git("config", "user.name", "t")
    writeFileSync(join(root, "issues.yml"), "list: [echo, hi]\n")
    git("add", "issues.yml")
    git("commit", "-q", "-m", "declare a one-shot reader only")
    const child = spawn(process.execPath, [YRD, "issues", "list-page-serve", "--project-root", root], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)))
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/list-page-serve is not declared/)
  }, 60_000)

  // @cto 18:01Z finding 1: node reports a spawn failure through the child's "error" event, never by throwing, so a
  // bare exit 1 here would be a silent error with no reason a host could show.
  it("names a reader whose argv does not exist, instead of a bare exit 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-cli-page-serve-missing-"))
    roots.push(root)
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t.t")
    git("config", "user.name", "t")
    writeFileSync(join(root, "issues.yml"), `list-page-serve: [${JSON.stringify(join(root, "no-such-reader"))}]\n`)
    git("add", "issues.yml")
    git("commit", "-q", "-m", "declare a reader that cannot start")
    const child = spawn(process.execPath, [YRD, "issues", "list-page-serve", "--project-root", root], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)))
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/yrd-issues-provider-missing/)
    expect(stderr).toMatch(/no-such-reader/)
    expect(stderr).toMatch(/ENOENT/)
  }, 60_000)
})
