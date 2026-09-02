#!/usr/bin/env bun
/**
 * Hold the queue runner lease from a SEPARATE process, using the product's own
 * lock primitive and holder format.
 *
 * A same-process hold cannot prove what the specimen was about: two `yrd queue
 * run` processes on one host. flock is per open file description, so a real
 * child is the only way to observe the kernel doing the excluding — and the
 * only way to kill a holder and watch the lease come back on its own.
 *
 * Prints `acquired` once it holds the lease, then holds until SIGTERM/SIGINT.
 */
import { createExclusive } from "@yrd/persistence"

const [dir, holder] = process.argv.slice(2)
if (dir === undefined || holder === undefined) {
  throw new Error("usage: hold-queue-runner-lease <lease-dir> <holder>")
}

const release = Promise.withResolvers<void>()
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => release.resolve())

await createExclusive(dir, { timeoutMs: 0 }).run(
  async () => {
    process.stdout.write("acquired\n")
    await release.promise
  },
  { holder },
)
