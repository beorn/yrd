import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { YRD_VERSION } from "../src/version.ts"

const root = resolve(import.meta.dirname, "../../..")

async function run(executable: "yrd" | "git-yrd", flag: "--version" | "-V") {
  const child = Bun.spawn([resolve(root, "bin", executable), flag], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("version CLI", () => {
  it.each([
    ["yrd", "--version"],
    ["yrd", "-V"],
    ["git-yrd", "--version"],
    ["git-yrd", "-V"],
  ] as const)("prints the distribution version for %s %s in production mode", async (executable, flag) => {
    expect(await run(executable, flag)).toEqual({ exitCode: 0, stdout: `${YRD_VERSION}\n`, stderr: "" })
  })
})
