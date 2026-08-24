import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const RUNNING_YRD_ENTRY = pathToFileURL(join(import.meta.dirname, "../../../../bin/yrd.ts")).href

/**
 * Give a synthetic repository the same declared Yrd entry that a real Yrd
 * checkout exposes at `bin/yrd`.
 *
 * Active hosts deliberately refuse repositories without this entry. The
 * fixture forwards to the checkout under test so receiver hooks exercise the
 * current implementation while retaining the production path contract.
 */
export async function installDeclaredYrdEntry(repo: string): Promise<string> {
  const entry = join(repo, "bin", "yrd")
  await mkdir(join(repo, "bin"), { recursive: true })
  await writeFile(entry, `#!/usr/bin/env bun\nimport ${JSON.stringify(RUNNING_YRD_ENTRY)}\n`, { mode: 0o755 })
  return entry
}
