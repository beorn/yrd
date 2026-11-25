/**
 * @failure  #38182 row 1: the sparse progress answer was a child per refresh — `yrd issues list-page --progress` spawned
 *           a yrd, a `km journal writes`, and a 20 GB store open (~1.5 s on /hh/pm) — so the cheapest read was the most
 *           expensive thing a host did. The resident reader must answer it itself from journal lines it folds on the
 *           connection it already holds, carrying `{seq, lagSeq, asOf}` so a reader can see how current it is, and it
 *           must rebuild once on start and once when the vault replaces its store, saying why.
 * @level    l2 — a real git repository on main with a real issues.yml, a fake page-serve provider that counts its own
 *           spawns and records every journal request, and yrd run as a real child process
 * @consumer #38182 hightea's page reader · @cto 77dd37ea conditions
 * @testonly none
 */
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const YRD = fileURLToPath(new URL("../../../bin/yrd", import.meta.url))

/** A provider that speaks km's page-serve frames, records its own spawns and every journal request it is asked. */
const PROVIDER = `
import { appendFileSync, readFileSync } from "node:fs"
const log = process.env.PROGRESS_LOG
appendFileSync(log, "spawn\\n")
const stateOf = () => JSON.parse(readFileSync(process.env.PROGRESS_STATE, "utf8"))
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n")
let held = ""
process.stdin.on("data", (chunk) => {
  held += chunk.toString()
  for (let at = held.indexOf("\\n"); at >= 0; at = held.indexOf("\\n")) {
    const line = held.slice(0, at)
    held = held.slice(at + 1)
    if (line.trim() === "") continue
    const frame = JSON.parse(line)
    const request = frame.request ?? {}
    if (request.journal !== undefined) {
      const state = stateOf()
      appendFileSync(log, "journal:" + String(request.journal.after) + "\\n")
      send({
        seq: frame.seq,
        journal: {
          generation: state.generation,
          head: state.head,
          asOf: Date.now(),
          lines: state.lines.filter((one) => one.seq > request.journal.after),
          more: false,
        },
      })
      continue
    }
    appendFileSync(log, "page:" + JSON.stringify(request) + "\\n")
    if (request.traverse === true && request.page === undefined) {
      send({ seq: frame.seq, page: { rows: ["one"], complete: false } })
    }
    send({ seq: frame.seq, page: { rows: ["one"], complete: true } })
  }
})
process.stdin.on("end", () => process.exit(0))
`

type Session = Readonly<{
  ask(frame: unknown): Promise<Record<string, unknown>>
  /** A traversal answers page after page and ends on a complete one, exactly as a client reads it. */
  askTraversal(frame: unknown): Promise<Record<string, unknown>[]>
  close(): Promise<void>
}>

type Runner = Readonly<{
  root: string
  log: string
  state: string
  write(state: { generation: string; head: number; lines: unknown[] }): void
  lines(): string[]
  /** One reader for several asks, so a change to the store lands while the SAME process is resident. */
  open(): Promise<Session>
}>

function runner(): Runner {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-page-serve-progress-"))
  roots.push(root)
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@t.t")
  git("config", "user.name", "t")
  const provider = join(root, "provider.mjs")
  writeFileSync(provider, PROVIDER)
  writeFileSync(
    join(root, "issues.yml"),
    `list-page-serve: [${JSON.stringify(process.execPath)}, ${JSON.stringify(provider)}]\n`,
  )
  git("add", "issues.yml", "provider.mjs")
  git("commit", "-q", "-m", "declare a page-serve reader")
  const log = join(root, "provider.log")
  const state = join(root, "state.json")
  writeFileSync(log, "")
  const write = (next: { generation: string; head: number; lines: unknown[] }): void => {
    writeFileSync(state, JSON.stringify(next))
  }
  const lines = (): string[] => readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
  const open = async (): Promise<Session> => {
    const child = spawn(process.execPath, [YRD, "issues", "list-page-serve", "--project-root", root], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PROGRESS_LOG: log, PROGRESS_STATE: state },
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const waiting: ((line: string) => void)[] = []
    const buffered: string[] = []
    let held = ""
    child.stdout.on("data", (chunk: Buffer) => {
      held += chunk.toString()
      for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
        buffered.push(held.slice(0, at))
        held = held.slice(at + 1)
      }
      while (buffered.length > 0 && waiting.length > 0) waiting.shift()?.(buffered.shift() as string)
    })
    let closed = false
    const ended = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve() }))
    const nextLine = async (): Promise<string> => {
      const answer = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer in 20 s; stderr: ${stderr}`)), 20_000)
        waiting.push((line) => {
          clearTimeout(timer)
          resolve(line)
        })
      })
      while (buffered.length > 0 && waiting.length > 0) waiting.shift()?.(buffered.shift() as string)
      return await answer
    }
    const ask = async (frame: unknown): Promise<Record<string, unknown>> => {
      const answer = nextLine()
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      return JSON.parse(await answer) as Record<string, unknown>
    }
    const askTraversal = async (frame: unknown): Promise<Record<string, unknown>[]> => {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      const pages: Record<string, unknown>[] = []
      for (;;) {
        const answer = JSON.parse(await nextLine()) as { page?: { complete?: unknown }; refusal?: unknown }
        pages.push(answer)
        if (answer.refusal !== undefined || answer.page?.complete === true) return pages
      }
    }
    const close = async (): Promise<void> => {
      if (closed) return
      child.stdin.end()
      await ended
    }
    return { ask, askTraversal, close }
  }
  return { root, log, state, write, lines, open }
}

describe("list-page-serve: the resident reader answers the progress frame itself", () => {
  it("answers a progress-only ask from journal lines, with seq/lagSeq/asOf, and spawns no second child", async () => {
    const run = runner()
    run.write({
      generation: "1:11",
      head: 3,
      lines: [
        { seq: 2, ts: Date.now() - 60_000, actor: "@dev/3", data: { path: "@km/0003-half-eaten.md" } },
        { seq: 3, ts: Date.now() - 30_000, actor: "@dev/3", data: { path: "@km/0004-closed.md" } },
      ],
    })
    const reader = await run.open()
    try {
      const first = await reader.ask({ seq: 1, request: { progress: true } })
      const second = await reader.ask({ seq: 2, request: { progress: true } })
      const third = await reader.ask({ seq: 3, request: { progress: true } })
      expect(first.seq).toBe(1)
      expect(first.progress).toMatchObject({ default: false, source: "ok", complete: true, seq: 3, lagSeq: 0 })
      expect(typeof (first.progress as { asOf?: unknown }).asOf).toBe("string")
      expect((first.progress as { qualifying: unknown }).qualifying).toEqual([
        { id: "bead:3", owner: "@dev/3", reason: expect.stringContaining("owner @dev/3") },
        { id: "bead:4", owner: "@dev/3", reason: expect.stringContaining("owner @dev/3") },
      ])
      expect(second.progress).toMatchObject({ seq: 3, lagSeq: 0 })
      expect(third.progress).toMatchObject({ seq: 3, lagSeq: 0 })
    } finally {
      await reader.close()
    }
    // Children spawned per read is 0, counted: the provider started once, and three answers added nothing.
    expect(run.lines().filter((line) => line === "spawn")).toHaveLength(1)
    // One rebuild at start (`after: 0`), then incremental reads from the change number already held.
    const journal = run.lines().filter((line) => line.startsWith("journal:"))
    expect(journal[0]).toBe("journal:0")
    expect(journal.slice(1)).toEqual(["journal:3", "journal:3", "journal:3"])
  }, 60_000)

  it("attaches the frame to the terminal page and never forwards Yrd's own flag", async () => {
    const run = runner()
    run.write({ generation: "1:11", head: 1, lines: [] })
    const reader = await run.open()
    let page: Record<string, unknown>
    let traversal: Record<string, unknown>[]
    try {
      page = await reader.ask({
        seq: 1,
        request: { binding: "b", population: "p", generation: "g", limit: 10, changedSince: 0, progress: true },
      })
      traversal = await reader.askTraversal({
        seq: 2,
        request: { binding: "b", population: "p", generation: "g", limit: 10, traverse: true, progress: true },
      })
    } finally {
      await reader.close()
    }
    expect(page.seq).toBe(1)
    expect((page.page as { progress?: unknown }).progress).toMatchObject({ source: "ok", complete: true })
    // Every page is relayed; the frame rides the terminal one, as the one-shot path annotates its last page.
    expect(traversal).toHaveLength(2)
    expect((traversal[0]!.page as { progress?: unknown }).progress).toBeUndefined()
    expect((traversal[1]!.page as { progress?: unknown }).progress).toMatchObject({ complete: true })
    const forwarded = run.lines().filter((line) => line.startsWith("page:"))
    expect(forwarded).toHaveLength(2)
    for (const line of forwarded) expect(line).not.toContain("progress")
  }, 60_000)

  it("relays a traversal page by page and rebuilds once when the vault replaces its store", async () => {
    const run = runner()
    run.write({
      generation: "1:11",
      head: 2,
      lines: [{ seq: 2, ts: Date.now() - 43_200_000, actor: "@dev/3", data: { path: "@km/0003-a.md" } }],
    })
    const reader = await run.open()
    try {
      const first = await reader.ask({ seq: 1, request: { progress: true } })
      expect((first.progress as { qualifying: { id: string }[] }).qualifying).toEqual([
        expect.objectContaining({ id: "bead:3" }),
      ])
      // The store is replaced while the reader stays up: a new generation, and a head that starts again.
      run.write({
        generation: "1:12",
        head: 1,
        lines: [{ seq: 1, ts: Date.now() - 10_000, actor: "@dev/6", data: { path: "@km/0007-b.md" } }],
      })
      const second = await reader.ask({ seq: 2, request: { progress: true } })
      expect((second.progress as { qualifying: { id: string }[] }).qualifying).toEqual([
        expect.objectContaining({ id: "bead:7" }),
      ])
      expect(second.progress).toMatchObject({ seq: 1, lagSeq: 0, source: "ok" })
    } finally {
      await reader.close()
    }
    // One provider for the whole session: the rotation cost a journal read, never a second child.
    expect(run.lines().filter((line) => line === "spawn")).toHaveLength(1)
    const journal = run.lines().filter((line) => line.startsWith("journal:"))
    // start rebuild, the incremental read that discovered the new generation, then the rebuild it triggered
    expect(journal).toEqual(["journal:0", "journal:2", "journal:2", "journal:0"])
  }, 60_000)
})
