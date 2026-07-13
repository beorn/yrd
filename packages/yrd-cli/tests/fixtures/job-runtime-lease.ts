import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createExclusive } from "@yrd/persistence"

const [registryArg, tokenArg, finalizeArg] = process.argv.slice(2)
if (registryArg === undefined || tokenArg === undefined || finalizeArg === undefined) {
  throw new Error("usage: job-runtime-lease <registry-root> <token> <finalize-path>")
}
const registryRoot = registryArg
const token = tokenArg
const finalizePath = finalizeArg

const stagingEntry = join(registryRoot, "staging", token)
const openEntry = join(registryRoot, "open", token)

await mkdir(stagingEntry, { recursive: true })

// The fixture exits from inside the exclusive operation on purpose: flock(2)
// is then released by the kernel with the process, never by an early finally.
await createExclusive(stagingEntry).run(async () => {
  await writeRuntime("registered")
  await rename(stagingEntry, openEntry)
  process.stdout.write("READY\n")

  while (!existsSync(finalizePath)) await Bun.sleep(10)
  await writeRuntime("finalized")
  process.exit(0)
})

async function writeRuntime(phase: "registered" | "finalized"): Promise<void> {
  const entry = existsSync(stagingEntry)
    ? stagingEntry
    : existsSync(openEntry)
      ? openEntry
      : join(registryRoot, "closing", token)
  await writeFile(
    join(entry, "runtime.json"),
    `${JSON.stringify({ schema: 1, token, phase, owner: { kind: "test", pid: process.pid } })}\n`,
  )
}
