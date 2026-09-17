/**
 * A process that holds a queue workdir's round lock the way a round takes it:
 * a kernel flock on the lock file, with a body that names the holder. Run by
 * `queue-lock.test.ts`, never by the queue.
 *
 *   bun round-lock-holder.ts hold <lock file>
 *     takes the lock, prints `held`, and holds it until its stdin closes
 *   bun round-lock-holder.ts spawn-and-die <lock file> <child pid file>
 *     takes the lock, starts a bun child that runs on, writes the child's pid,
 *     and kills itself without releasing anything
 *
 * Exits 3 when the lock is already held, so a holder that never took it cannot
 * pass for one that did.
 */

import { writeFileSync } from "node:fs"
import { tryAcquireFlock } from "@bearly/flock"

const [mode, lockFile, childPidFile] = process.argv.slice(2)
if (lockFile === undefined) {
  process.stderr.write("round-lock-holder: usage: <hold|spawn-and-die> <lock file> [child pid file]\n")
  process.exit(2)
}

const lock = tryAcquireFlock(lockFile, {
  body: `${JSON.stringify({ command: `round-lock-holder ${String(mode)}`, pid: process.pid, since: new Date().toISOString() })}\n`,
})
if (lock === null) {
  process.stderr.write(`round-lock-holder: ${lockFile} is already held\n`)
  process.exit(3)
}

if (mode === "hold") {
  process.stdin.on("end", () => process.exit(0))
  process.stdin.resume()
  process.stdout.write("held\n")
} else if (mode === "spawn-and-die" && childPidFile !== undefined) {
  // A round's children are started with only the stdio they name, as the
  // queue's own process runner starts them.
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  })
  writeFileSync(childPidFile, String(child.pid))
  process.kill(process.pid, "SIGKILL")
} else {
  process.stderr.write(`round-lock-holder: unknown mode ${String(mode)}\n`)
  process.exit(2)
}
