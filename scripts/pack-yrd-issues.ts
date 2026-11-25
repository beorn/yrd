#!/usr/bin/env bun
/**
 * pack-yrd-issues — cut the one tarball Hightea pins for `@yrd/issues`, from a tag, with its sha256 beside it.
 *
 * Why: `@yrd/issues` is the shared issues contract (@cto 37a8972c, hh #37445). Hightea is a separate repository and
 * cannot import a private workspace package, so it consumes the package the way it consumes `@ahpd/*`: a release asset
 * pinned by URL and by sha256. That only means something if the asset is tied to the tag it claims to be: so this
 * refuses to run on a dirty tree, or on a HEAD that is not the tag, and refuses a tag that does not exist.
 *
 * The archive is cut by `bun pm pack`, so it is npm's own layout and honours the package's `files` list — this script
 * adds the two things npm pack does not: the tag/HEAD gate, and the sha256 written next to the asset.
 *
 * Usage: bun scripts/pack-yrd-issues.ts --tag yrd-issues-v<version> [--out <directory>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const PACKAGE_DIR = join(ROOT, "packages", "yrd-issues")

const refuse = (detail: string): never => {
  throw new Error(`pack-yrd-issues: ${detail}`)
}

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", ROOT, ...args], { stdout: "pipe", stderr: "pipe" })
  const stderr = run.stderr.toString().trim()
  if (run.exitCode !== 0) return refuse(`git ${args.join(" ")} failed: ${stderr === "" ? "(no output)" : stderr}`)
  return run.stdout.toString().trim()
}

/** One tool and its version, so a cut always says what cut it. A missing tool says so rather than disappearing. */
function toolVersion(label: string, command: string[]): string {
  const run = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) return `${label} unavailable`
  const text = run.stdout.toString().trim().split("\n")[0] ?? ""
  // `git --version` already says "git"; do not print it twice.
  return text.toLowerCase().startsWith(label.toLowerCase()) ? text : `${label} ${text}`
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith("--")) refuse(`${name} needs a value`)
  return value
}

function main(): void {
  const tag = argument("--tag") ?? refuse("--tag names the release tag this asset belongs to (e.g. yrd-issues-v0.1.0)")

  const dirty = git("status", "--porcelain")
  if (dirty !== "") refuse(`the tree is dirty; a release asset is cut from a committed tag, not a working tree:\n${dirty}`)

  const head = git("rev-parse", "HEAD")
  const tagged = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`)
  if (head !== tagged) refuse(`HEAD ${head.slice(0, 12)} is not tag ${tag} (${tagged.slice(0, 12)}); check out the tag's commit first`)

  const outDir = argument("--out") ?? join(ROOT, "dist")
  mkdirSync(outDir, { recursive: true })
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", outDir], {
    cwd: PACKAGE_DIR,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (packed.exitCode !== 0) {
    return refuse(`bun pm pack failed: ${packed.stderr.toString().trim() || packed.stdout.toString().trim() || "(no output)"}`)
  }
  // `bun pm pack` names the archive as npm does: scoped `@scope/name` becomes `scope-name-<version>.tgz`.
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { name: string; version: string }
  const archive = `${manifest.name.replace(/^@([^/]+)\//u, "$1-")}-${manifest.version}.tgz`
  const path = join(outDir, archive)
  if (!existsSync(path)) return refuse(`bun pm pack did not produce ${archive} in ${outDir}`)
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex")
  writeFileSync(`${path}.sha256`, `${digest}  ${archive}\n`)

  const lines = [
    `${archive}`,
    `sha256 ${digest}`,
    `tag ${tag} at ${head}`,
    toolVersion("bun", ["bun", "--version"]),
    toolVersion("git", ["git", "--version"]),
    toolVersion("npm", ["npm", "--version"]),
    path,
    `${path}.sha256`,
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
}

if (import.meta.main) main()
