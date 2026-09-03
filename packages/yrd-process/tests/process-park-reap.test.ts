/**
 * @failure A required check whose run ends by park (abort) or timeout leaves its
 *          child tree alive — reparented to PPID=1 and spinning a core unbounded,
 *          the exact 2026-08-18 specimen (`bun tools/manifest-co-change.ts` at
 *          99.5% CPU for 63 minutes under an `sh -c` wrapper owned by init).
 * @level   l2
 * @consumer @i/10-yrd/parked-checks-are-reaped
 */
import { afterEach, describe, expect, test } from "vitest"
import { createProcess, shellCommand } from "../src/index.ts"

/**
 * The census the specimen was FOUND by, run as an assertion instead of around the queue.
 *
 * `waitDead` (process-tree.test.ts) asks whether one known pid is gone; that
 * cannot see a descendant whose pid the fixture never recorded, and the
 * specimen's second process was exactly that. This reads the whole live process
 * table and keeps every row carrying the run's unique marker, so an unrecorded
 * survivor is still caught — and it keeps PPID, because "reparented to 1" is the
 * signature that separates an orphan from a child still owned by its runner.
 */
function census(marker: string): readonly { pid: number; ppid: number; args: string }[] {
  const listed = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,args="])
  if (listed.exitCode !== 0) {
    // NO SILENT ERRORS: an unreadable process table must never read as "no
    // survivors" — that is the reading this whole test exists to distrust.
    throw new Error(`ps census failed (exit ${String(listed.exitCode)}): ${new TextDecoder().decode(listed.stderr)}`)
  }
  return new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
      if (match === null || !line.includes(marker)) return []
      return [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? "" }]
    })
}

/** Poll the census until it is empty or `ms` elapses, so a reap in flight is not
 * read as a survivor. Returns the LAST census, which is what gets asserted. */
async function settledCensus(marker: string, ms: number): Promise<readonly { pid: number; ppid: number }[]> {
  const deadline = Date.now() + ms
  let rows = census(marker)
  while (rows.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    rows = census(marker)
  }
  return rows
}

const markers: string[] = []
afterEach(() => {
  // Hygiene before anything else: a red must never leave a core spinning.
  for (const marker of markers.splice(0)) {
    for (const row of census(marker)) {
      try {
        process.kill(row.pid, "SIGKILL")
      } catch {
        // silent-fallback-allow: ESRCH means cleanup already reached the asserted dead state.
      }
    }
  }
})

/**
 * A check child in the shape the queue actually spawns: `shellCommand()` wraps
 * every configured check's `run:` in `sh -c`, and the specimen's orphan was that
 * wrapper. The work underneath is a real CPU-bound spin, not a `sleep` — a
 * sleeping process dies to any signal, so it cannot distinguish a working
 * reaper from a lucky one, and the specimen was burning a core.
 */
function checkTree(marker: string, options: Readonly<{ ignoreTerm: boolean }>): readonly string[] {
  const body =
    (options.ignoreTerm ? `process.on("SIGTERM",()=>{});` : "") +
    `const until=Date.now()+120000; while(Date.now()<until){}`
  return shellCommand(`exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(body)} ${marker}`)
}

function uniqueMarker(name: string): string {
  const marker = `YRDREAP${name}${String(process.pid)}${Math.random().toString(36).slice(2, 8)}`
  markers.push(marker)
  return marker
}

describe("createProcess — a check that ends by park or timeout is reaped (@i/10-yrd/parked-checks-are-reaped)", () => {
  test.runIf(process.platform === "linux" || process.platform === "darwin")(
    "a check run concluded by PARK (its job signal aborts) leaves no survivor, and none owned by init",
    async () => {
      const marker = uniqueMarker("PARK")
      // The park shape: the queue's job context aborts. `configuredCommand`
      // passes that signal straight into `process.run`, so this is the whole
      // route from "the run was set aside" to the process-group reaper.
      const parked = new AbortController()
      await using proc = createProcess({ killGraceMs: 500 })
      const run = proc.run({
        argv: checkTree(marker, { ignoreTerm: false }),
        signal: parked.signal,
        timeoutMs: 120_000,
      })
      // Positive control: the tree must be ALIVE before the park, or a zero
      // afterwards would only prove the fixture never started.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(census(marker).length, "check tree never started; a later zero would prove nothing").toBeGreaterThan(0)

      parked.abort()
      const result = await run

      expect(result.signal).toBe("SIGTERM")
      expect(result.sweepFailure).toBeUndefined()
      const survivors = await settledCensus(marker, 5_000)
      expect(survivors, `parked check left survivors: ${JSON.stringify(survivors)}`).toEqual([])
    },
    60_000,
  )

  test.runIf(process.platform === "linux" || process.platform === "darwin")(
    "a TERM-ignoring check run concluded by TIMEOUT is escalated to SIGKILL; no survivor is reparented to init",
    async () => {
      const marker = uniqueMarker("TMO")
      await using proc = createProcess({ killGraceMs: 500 })
      // Positive control, taken while the run is still in flight: `timedOut`
      // would be true even if the fixture had never spawned, so without this a
      // reaper that does nothing at all still reads green.
      let alive = 0
      const run = proc.run({
        argv: checkTree(marker, { ignoreTerm: true }),
        timeoutMs: 2_500,
        onStart: () => {
          setTimeout(() => {
            alive = census(marker).length
          }, 1_000)
        },
      })
      const result = await run

      expect(alive, "check tree never started; a later zero would prove nothing").toBeGreaterThan(0)
      expect(result.timedOut).toBe(true)
      const survivors = await settledCensus(marker, 5_000)
      expect(survivors, `timed-out check left survivors: ${JSON.stringify(survivors)}`).toEqual([])
      expect(survivors.filter((row) => row.ppid === 1)).toEqual([])
    },
    60_000,
  )

  test.runIf(process.platform === "linux" || process.platform === "darwin")(
    "a parked check whose runner EXITS before the kill grace elapses is still reaped — the 2026-08-18 specimen",
    async () => {
      const marker = uniqueMarker("EXIT")
      // The specimen exactly. `executeWithHeartbeat` detaches a run it has
      // abandoned (`void execution.catch(...)`) after aborting its scope, so
      // SIGTERM goes out but the SIGKILL escalation is a TIMER — and a timer
      // dies with the process that armed it. A runner that exits inside the
      // grace therefore leaves a TERM-ignoring check child alive, owned by
      // init, spinning a core with nobody left to bound it. That is why the
      // specimen was found by `/host-health` and not by the queue.
      const moduleUrl = new URL("../src/index.ts", import.meta.url).href
      const runner = [
        `const { createProcess, shellCommand } = await import(${JSON.stringify(moduleUrl)})`,
        `const body = ${JSON.stringify(`process.on("SIGTERM",()=>{}); const until=Date.now()+120000; while(Date.now()<until){}`)}`,
        `const argv = shellCommand("exec " + JSON.stringify(process.execPath) + " -e " + JSON.stringify(body) + " ${marker}")`,
        `const parked = new AbortController()`,
        // A generous grace, so the leak is about the runner leaving rather than
        // about the escalation being too slow to observe.
        `const proc = createProcess({ killGraceMs: 10_000 })`,
        `void proc.run({ argv, signal: parked.signal, timeoutMs: 120_000 }).catch(() => undefined)`,
        `await new Promise((resolve) => setTimeout(resolve, 1_500))`,
        `parked.abort()`,
        `process.exit(0)`,
      ].join("\n")

      const helper = Bun.spawn([process.execPath, "-e", runner], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stderr, exitCode] = await Promise.all([new Response(helper.stderr).text(), helper.exited])
      expect(exitCode, stderr).toBe(0)

      const survivors = await settledCensus(marker, 8_000)
      expect(
        survivors,
        `the runner exited and left its check child alive: ${JSON.stringify(survivors)} — the specimen's signature`,
      ).toEqual([])
      expect(survivors.filter((row) => row.ppid === 1)).toEqual([])
    },
    60_000,
  )
})
