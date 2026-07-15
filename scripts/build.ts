import { chmod, mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dist = resolve(root, "dist")
await rm(dist, { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [resolve(root, "bin/yrd.ts")],
  outdir: dist,
  naming: "yrd.js",
  target: "bun",
  // The live watch UI is reached through a dynamic import in run.ts so it stays a separate
  // chunk: non-watch commands (yrd --version, submit, one-shot queue) never load it, and the
  // core bundle does not top-level-import silvery's TUI-only SplitPane.
  splitting: true,
  external: ["react", "react/*", "silvery", "silvery/*", "@silvery/*", "loggily", "zod"],
})
if (!result.success) throw new AggregateError(result.logs, "Could not build Yrd")

const bin = resolve(dist, "bin")
await mkdir(bin, { recursive: true })
for (const name of ["yrd", "git-yrd", "git-bay"]) {
  const path = resolve(bin, name)
  await Bun.write(path, '#!/usr/bin/env bun\nimport "../yrd.js"\n')
  await chmod(path, 0o755)
}
