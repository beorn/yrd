#!/usr/bin/env bun
/**
 * pack-yrd-issues — cut the one tarball Hightea pins, reproducibly, so a tag's asset can be checked by sha256 forever.
 *
 * Why: `@yrd/issues` is the shared issues contract (@cto 37a8972c, hh #37445). Hightea is a separate repository and
 * cannot import a private workspace package, so it consumes the package exactly as it consumes `@ahpd/*`: a released
 * tarball pinned by URL and by the sha256 of its bytes. That makes reproducibility the whole point — if two runs of
 * this script produce different bytes, no one can tell a re-cut from a tampered asset, and the pin means nothing.
 *
 * So every input that a tarball normally varies on is fixed: entries are sorted, mtime is `SOURCE_DATE_EPOCH` (default
 * 0), uid/gid are 0 with empty owner names, modes are 0644/0755 by kind, and the gzip header carries no timestamp or
 * name. `--check` packs twice and refuses if the two digests differ.
 *
 * Usage: bun scripts/pack-yrd-issues.ts [--out <path>] [--check]
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const PACKAGE_DIR = join(ROOT, "packages", "yrd-issues")

/** The archive's one top-level directory, as npm's own packs use, so a `file:`/URL dependency resolves a package. */
const ARCHIVE_ROOT = "package"

const BLOCK = 512
const MODE_FILE = 0o644

function oct(value: number, width: number): string {
  // Numeric fields are octal, zero-padded, NUL-terminated; the field is `width - 1` digits plus the NUL.
  return `${value.toString(8).padStart(width - 1, "0")}\0`
}

function header(name: string, size: number, mtime: number, mode: number): Buffer {
  const buf = Buffer.alloc(BLOCK)
  const put = (offset: number, width: number, text: string): void => {
    const bytes = Buffer.from(text, "utf8")
    if (bytes.length > width) throw new Error(`pack-yrd-issues: ${JSON.stringify(name)} is longer than the ustar field`)
    bytes.copy(buf, offset)
  }
  put(0, 100, name)
  put(100, 8, oct(mode, 8))
  put(108, 8, oct(0, 8)) // uid
  put(116, 8, oct(0, 8)) // gid
  put(124, 12, oct(size, 12))
  put(136, 12, oct(mtime, 12))
  buf.fill(0x20, 148, 156) // checksum field: spaces while summing
  buf[156] = 0x30 // typeflag: regular file
  put(257, 6, "ustar\0")
  put(263, 2, "00")
  let sum = 0
  for (const byte of buf) sum += byte
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return buf
}

/** What the archive leaves out: the package's own tests are not part of what a consumer resolves. */
const NOT_SHIPPED = new Set(["tests"])

/** Every file the package ships, in one stable order: `package.json` first, then the sources by path. */
function packageFiles(): { readonly path: string; readonly relative: string }[] {
  const files: { path: string; relative: string }[] = []
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (NOT_SHIPPED.has(prefix === "" ? name : `${prefix}/${name}`)) continue
      const path = join(directory, name)
      const relative = prefix === "" ? name : `${prefix}/${name}`
      if (statSync(path).isDirectory()) walk(path, relative)
      else files.push({ path, relative })
    }
  }
  walk(PACKAGE_DIR, "")
  const order = (relative: string): number => (relative === "package.json" ? 0 : 1)
  return files.sort((a, b) => order(a.relative) - order(b.relative) || (a.relative < b.relative ? -1 : 1))
}

/** The tarball's bytes. Two calls on an unchanged tree are byte-identical, which `--check` proves. */
export function packYrdIssues(mtime = Number(process.env.SOURCE_DATE_EPOCH ?? "0")): Uint8Array {
  const blocks: Buffer[] = []
  for (const file of packageFiles()) {
    const content = readFileSync(file.path)
    blocks.push(header(`${ARCHIVE_ROOT}/${file.relative}`, content.length, mtime, MODE_FILE))
    blocks.push(content)
    const remainder = content.length % BLOCK
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK - remainder))
  }
  blocks.push(Buffer.alloc(BLOCK * 2)) // the archive ends with two empty blocks
  return Bun.gzipSync(Buffer.concat(blocks))
}

function main(): void {
  const args = process.argv.slice(2)
  const outAt = args.indexOf("--out")
  const version = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version as string
  const bytes = packYrdIssues()
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (args.includes("--check")) {
    const again = new Bun.CryptoHasher("sha256").update(packYrdIssues()).digest("hex")
    if (again !== digest) throw new Error(`pack-yrd-issues: two packs differ (${digest} vs ${again}); the asset is not reproducible`)
  }
  const out =
    outAt === -1
      ? join(ROOT, "dist", `yrd-issues-${version}.tgz`)
      : (args[outAt + 1] ?? (() => { throw new Error("pack-yrd-issues: --out needs a path") })())
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, bytes)
  process.stdout.write(`yrd-issues-${version}.tgz\tsha256 ${digest}\t${bytes.length} bytes\n${out}\n`)
}

if (import.meta.main) main()
