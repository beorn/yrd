/**
 * @failure A source file carries a raw NUL byte, so every byte-oriented reader treats it as binary and stops mid-file.
 * @level l1
 * @consumer repo hygiene
 */
import type { Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * A raw 0x00 inside a source file is invisible in an editor and fatal to the
 * tools everyone greps with: `grep` calls the file binary and prints nothing,
 * `rg` needs `-a`, and a reader who does not know to pass it reads a silent
 * zero as "not in this file". It is never load-bearing — every raw NUL a string
 * literal needs can be written as the `\0` escape for a byte-identical runtime
 * value and a file that stays text.
 *
 * The class, not the instance: the two files this test was written for
 * (`yrd-cli/src/host.ts`'s merged-truth memo key, `yrd-queue/tests/command.test.ts`'s
 * `toContain` fallback) were found by a scan whose FIRST run turned up the
 * second one nobody had reported. So the pin walks every source and test file
 * under `packages/`, not the two known sites.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/** Every `.ts`/`.tsx` under one directory, recursively. Absent directories contribute nothing. */
async function collect(dir: string, out: string[]): Promise<void> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collect(path, out)
      continue
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(path)
  }
}

async function sourceFiles(): Promise<string[]> {
  const packagesDir = join(repoRoot, "packages")
  const packages = await readdir(packagesDir, { withFileTypes: true })
  const out: string[] = []
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue
    await collect(join(packagesDir, pkg.name, "src"), out)
    await collect(join(packagesDir, pkg.name, "tests"), out)
  }
  return out.sort()
}

describe("source files stay text", () => {
  it("finds the tree it claims to scan — the positive control for the zero below", async () => {
    const files = await sourceFiles()
    // Without this, a walk that resolved the wrong root, or one whose recursion
    // silently returned nothing, would report "no raw NUL bytes" and be believed.
    expect(files.length).toBeGreaterThan(100)
    const relatives = files.map((file) => relative(repoRoot, file))
    expect(relatives).toContain(join("packages", "yrd-cli", "src", "host.ts"))
    expect(relatives).toContain(join("packages", "yrd-queue", "tests", "command.test.ts"))
  })

  it("carries no raw NUL byte in any .ts/.tsx under packages/*/src or packages/*/tests", async () => {
    const files = await sourceFiles()
    const offenders: string[] = []
    for (const file of files) {
      const bytes = await readFile(file)
      const at = bytes.indexOf(0)
      if (at !== -1) offenders.push(`${relative(repoRoot, file)} (byte ${at})`)
    }
    // Named, not counted: the cure is per-site — write the byte as the `\0`
    // escape, which is the same character to the runtime and text to a reader.
    expect(offenders).toEqual([])
  })

  it("keeps the merged-truth memo key a NUL-separated pair, written as an escape", async () => {
    const host = await readFile(join(repoRoot, "packages", "yrd-cli", "src", "host.ts"), "utf8")
    // The separator must stay a NUL: it is the one byte that cannot occur in a
    // repo path or a sha, so `repo` and `tip` can never be confused across it.
    expect(host).toContain("const key = `${index.repo}\\0${index.tip}`")
    // And the escape IS that byte — the edit that made the file greppable
    // changed the source encoding, never the key.
    expect("\0".charCodeAt(0)).toBe(0)
    expect(`a\0b`).toBe(`a${String.fromCharCode(0)}b`)
  })
})
