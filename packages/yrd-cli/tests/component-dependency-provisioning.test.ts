/**
 * @failure Yrd's standalone required check borrows HH workspace packages or
 * runs against stale published Silvery/Termless versions, turning a clean
 * component candidate into dozens of environment-red test failures.
 * @level l2
 * @consumer Yrd's own .yrd.yml component verification
 */

import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ComponentProvisioningError,
  provisionComponentDependencies,
  type ComponentDependency,
} from "../../../scripts/component-dependencies.ts"

const fixtures: string[] = []

function fixture(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `${name}-`))
  fixtures.push(path)
  return path
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const detail = `${result.stdout.toString()}${result.stderr.toString()}`
  expect(result.exitCode, detail).toBe(0)
  return result.stdout.toString().trim()
}

function dependencyRepository(): Readonly<{ path: string; revision: string }> {
  const path = fixture("yrd-component-dependency")
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.com")
  git(path, "config", "user.name", "Test")
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }))
  writeFileSync(join(path, "index.ts"), "export const fixtureDependency = true\n")
  mkdirSync(join(path, "node_modules", "react"), { recursive: true })
  writeFileSync(join(path, "node_modules", "react", "package.json"), JSON.stringify({ name: "react", private: true }))
  mkdirSync(join(path, "node_modules", "@types", "react"), { recursive: true })
  writeFileSync(
    join(path, "node_modules", "@types", "react", "package.json"),
    JSON.stringify({ name: "@types/react", private: true }),
  )
  git(path, "add", ".")
  git(path, "commit", "-qm", "fixture dependency")
  return { path, revision: git(path, "rev-parse", "HEAD") }
}

function candidate(): string {
  const path = fixture("yrd-component-candidate")
  mkdirSync(join(path, "node_modules", "fixture-dependency"), { recursive: true })
  writeFileSync(join(path, "node_modules", "fixture-dependency", "stale.txt"), "published fallback\n")
  mkdirSync(join(path, "node_modules", "react"), { recursive: true })
  writeFileSync(join(path, "node_modules", "react", "package.json"), JSON.stringify({ name: "react", private: true }))
  mkdirSync(join(path, "node_modules", "@types", "react"), { recursive: true })
  writeFileSync(
    join(path, "node_modules", "@types", "react", "package.json"),
    JSON.stringify({ name: "@types/react", private: true }),
  )
  const consumer = join(path, "packages", "consumer")
  mkdirSync(join(consumer, "node_modules", "fixture-dependency"), { recursive: true })
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }))
  writeFileSync(join(consumer, "node_modules", "fixture-dependency", "stale.txt"), "nested fallback\n")
  return path
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("standalone component dependency provisioning", () => {
  it("checks out exact pushed revisions and idempotently links their declared packages", async () => {
    const source = dependencyRepository()
    const root = candidate()
    const dependency: ComponentDependency = {
      name: "fixture",
      repository: source.path,
      revision: source.revision,
      packages: { "fixture-dependency": "." },
    }

    await provisionComponentDependencies({ root, dependencies: [dependency] })
    await provisionComponentDependencies({ root, dependencies: [dependency] })

    const installed = join(root, "node_modules", "fixture-dependency")
    expect(lstatSync(installed).isSymbolicLink()).toBe(true)
    expect(realpathSync(installed)).toBe(realpathSync(join(root, ".yrd-deps", "fixture")))
    expect(realpathSync(join(root, "packages", "consumer", "node_modules", "fixture-dependency"))).toBe(
      realpathSync(join(root, ".yrd-deps", "fixture")),
    )
    expect(realpathSync(join(root, ".yrd-deps", "fixture", "node_modules", "react"))).toBe(
      realpathSync(join(root, "node_modules", "react")),
    )
    expect(realpathSync(join(root, ".yrd-deps", "fixture", "node_modules", "@types", "react"))).toBe(
      realpathSync(join(root, "node_modules", "@types", "react")),
    )
    expect(readFileSync(join(installed, "index.ts"), "utf8")).toContain("fixtureDependency")
    expect(git(join(root, ".yrd-deps", "fixture"), "rev-parse", "HEAD")).toBe(source.revision)
  })

  it("names an unavailable dependency revision as a typed provisioning error", async () => {
    const source = dependencyRepository()
    const root = candidate()
    const missingRevision = "f".repeat(40)
    const dependency: ComponentDependency = {
      name: "fixture",
      repository: source.path,
      revision: missingRevision,
      packages: { "fixture-dependency": "." },
    }

    await expect(provisionComponentDependencies({ root, dependencies: [dependency] })).rejects.toMatchObject({
      name: "ComponentProvisioningError",
      code: "component-dependency-provision-failed",
      dependency: "fixture",
      revision: missingRevision,
    } satisfies Partial<ComponentProvisioningError>)
  })
})
