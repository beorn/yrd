// @failure Retired public vocabulary or workspace identities re-enter Yrd after the pre-1.0 cutover.
// @level l2
// @consumer Yrd packages, product docs, and frozen workspace lock

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../..")
const scannedExtensions = new Set([".json", ".md", ".ts", ".tsx", ".yml"])

function scannedFiles(path: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...scannedFiles(child))
    else if (extname(entry.name) === "" || scannedExtensions.has(extname(entry.name)) || entry.name === "bun.lock") {
      files.push(child)
    }
  }
  return files
}

describe("noun cutover ratchet", () => {
  it("documents public recovery and the command-event core model", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8")
    const prose = readme.replaceAll(/\s+/gu, " ")
    expect(prose).toContain("`yrd queue recover` is the public repair path")
    expect(prose).toContain("documents Commands, Events, projection, and the private Journal transaction contract")
    expect(readme).toContain("| `@yrd/core`        | Immutable definition, Commands, Events, projection, Journal")
    expect(readme).not.toContain("Runner-lease recovery remains\nan embedded/API capability")
    expect(readme).not.toContain("documents Operations, transaction\nframes")
  })

  it("keeps retired nouns and routes out of product code and current documentation", () => {
    const queueNoun = ["li", "ne"].join("")
    const issueNoun = ["ta", "sk"].join("")
    const runnerNoun = ["exec", "utor"].join("")
    const waitOption = `--${["wa", "it"].join("")}`
    const integrateVerb = ["inte", "grate"].join("")
    const holdVerb = ["ho", "ld"].join("")
    const releaseVerb = ["re", "lease"].join("")
    const statusVerb = ["sta", "tus"].join("")
    const showVerb = ["sh", "ow"].join("")
    const logVerb = ["lo", "g"].join("")
    const evaluateVerb = ["eval", "uate"].join("")
    const competeVerb = ["com", "pete"].join("")
    const adminNoun = ["ad", "min"].join("")
    const forbidden = [
      new RegExp(`\\b${queueNoun}s?\\b`, "iu"),
      new RegExp(`\\b${queueNoun}[-A-Z_]`, "u"),
      new RegExp(`\\b${queueNoun.toUpperCase()}[A-Z_]`, "u"),
      new RegExp(`\\b${queueNoun[0]?.toUpperCase()}${queueNoun.slice(1)}[A-Z_]`, "u"),
      new RegExp(issueNoun, "iu"),
      new RegExp(runnerNoun, "iu"),
      new RegExp(waitOption, "u"),
      new RegExp(
        `\\bqueue\\s+(?:${integrateVerb}|${holdVerb}|${releaseVerb}|${statusVerb}|${showVerb}|${logVerb})\\b`,
        "iu",
      ),
      new RegExp(`\\byrd\\s+(?:${integrateVerb}|${holdVerb}|${releaseVerb}|${adminNoun})\\b`, "iu"),
      new RegExp(`\\byrd\\s+run\\b`, "iu"),
      new RegExp(`\\bcontest\\s+(?:${evaluateVerb}|${showVerb})\\b`, "iu"),
      new RegExp(`\\bissue\\s+${competeVerb}\\b`, "iu"),
      new RegExp(`\\bqueue\\s+run[^\\n]{0,80}${["--re", "try"].join("")}`, "iu"),
    ]
    // These files define, project, or assert the standard compiler diagnostic position record.
    const diagnosticFieldFiles = new Set([
      "packages/yrd-cli/src/queue-status-view.tsx",
      "packages/yrd-cli/tests/cli.test.ts",
      "packages/yrd-queue/src/command.ts",
      "packages/yrd-queue/tests/command.test.ts",
    ])
    const diagnosticObjectField = new RegExp(`\\b${queueNoun}(?=\\s*:)`, "gu")
    const diagnosticPropertyAccess = new RegExp(`\\.${queueNoun}\\b`, "gu")
    const retiredBaseOptionAssertion = `.not.toContain("--${queueNoun} <branch>")`
    const matches = (relative: string, text: string): string[] => {
      let searchable = diagnosticFieldFiles.has(relative)
        ? text.replaceAll(diagnosticObjectField, "").replaceAll(diagnosticPropertyAccess, "")
        : text
      if (relative === "packages/yrd-cli/tests/cli.test.ts" && searchable.includes(retiredBaseOptionAssertion)) {
        searchable = searchable.replace(`--${queueNoun} <branch>`, "")
      }
      return forbidden.flatMap((expression) => {
        const match = expression.exec(searchable)
        return match === null ? [] : [match[0]]
      })
    }

    // The standard compiler diagnostic position field is not the retired Yrd Queue noun.
    expect(
      matches(
        "packages/yrd-queue/src/command.ts",
        `{ file: "src/index.ts", ${queueNoun}: 12, message: "type mismatch" }`,
      ),
    ).toEqual([])
    for (const retiredSense of [`$ yrd ${queueNoun}`, `$ yrd ${queueNoun} status`, `--${queueNoun} main`]) {
      expect(matches("README.md", retiredSense), retiredSense).not.toEqual([])
    }

    const failures: string[] = []
    const lintDirective = ["next", queueNoun].join("-")
    for (const file of [
      join(root, "README.md"),
      join(root, "ARCHITECTURE.md"),
      join(root, "TODO.md"),
      join(root, "package.json"),
      join(root, "bun.lock"),
      ...scannedFiles(join(root, "bin")),
      ...scannedFiles(join(root, "docs")),
      ...scannedFiles(join(root, "packages")),
      ...scannedFiles(join(root, "scripts")),
    ]) {
      const relative = file.slice(root.length + 1)
      for (const [index, text] of readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
        const searchable = text.replaceAll(lintDirective, "")
        for (const match of matches(relative, searchable)) failures.push(`${relative}:${index + 1}: ${match}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("accepts the checked-in workspace lock in frozen mode", () => {
    const standalone = mkdtempSync(join(tmpdir(), "yrd-frozen-lock-"))
    try {
      copyFileSync(join(root, "package.json"), join(standalone, "package.json"))
      copyFileSync(join(root, "bun.lock"), join(standalone, "bun.lock"))
      for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const manifest = join(root, "packages", entry.name, "package.json")
        if (!existsSync(manifest)) continue
        const target = join(standalone, "packages", entry.name)
        mkdirSync(target, { recursive: true })
        copyFileSync(manifest, join(target, "package.json"))
      }
      const before = readFileSync(join(standalone, "bun.lock"), "utf8")
      const result = Bun.spawnSync({
        cmd: ["bun", "install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"],
        cwd: standalone,
        stdout: "pipe",
        stderr: "pipe",
      })
      const detail = `${result.stdout.toString()}${result.stderr.toString()}`
      expect(result.exitCode, detail).toBe(0)
      expect(readFileSync(join(standalone, "bun.lock"), "utf8"), detail).toBe(before)
    } finally {
      rmSync(standalone, { recursive: true, force: true })
    }
  })
})
