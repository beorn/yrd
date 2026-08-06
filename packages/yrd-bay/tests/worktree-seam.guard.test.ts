/**
 * @failure A Yrd domain can bypass the shared worktree capability and recreate divergent add/remove safety policy.
 * @level l1
 * @consumer Root `guards` project and every Yrd production worktree lifecycle
 */
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const YRD_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const CAPABILITY = "packages/yrd-bay/src/git-worktree-store.ts"
const DIRECT_MUTATION = /["']worktree["']\s*,\s*["'](?:add|remove)["']/gu

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ? [path] : []
    }),
  )
  return nested.flat()
}

describe("shared Yrd worktree seam", () => {
  it("is the only production source allowed to invoke git worktree add/remove", async () => {
    const files = await sourceFiles(join(YRD_ROOT, "packages"))
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(true)
    const offenders: string[] = []
    for (const file of files) {
      const local = relative(YRD_ROOT, file)
      if (!local.includes("/src/") || local === CAPABILITY) continue
      const source = await readFile(file, "utf8")
      for (const match of source.matchAll(DIRECT_MUTATION)) {
        const line = source.slice(0, match.index).split("\n").length
        offenders.push(`${local}:${line}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
