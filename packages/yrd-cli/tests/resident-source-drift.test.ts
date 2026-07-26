/**
 * @failure A long-lived queue resident keeps claiming runs after the authoritative Yrd source gitlink advances.
 * @level l3
 * @consumer @yrd/cli resident run gate
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const source = vi.hoisted(() => ({
  loaded: "git:35562d1579f140669a453b310340582b8cc1b42f",
  current: "git:35562d1579f140669a453b310340582b8cc1b42f",
  authoritative: "git:35562d1579f140669a453b310340582b8cc1b42f",
}))

vi.mock("../src/implementation-source.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/implementation-source.ts")>()),
  sourceRepositoryFor: () => ({ root: "/mock/yrd" }),
  implementationSourceIdentity: async () => source.current,
  authoritativeImplementationSource: async () => source.authoritative,
}))

import { createYrdHost } from "../src/host.ts"
import { requireFreshInstalledBaseline } from "../src/run.ts"

const roots: string[] = []

afterEach(async () => {
  source.loaded = "git:35562d1579f140669a453b310340582b8cc1b42f"
  source.current = source.loaded
  source.authoritative = source.loaded
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function queueRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-source-drift-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), "base: main\nbatch: 1\nsteps: [merge]\nmerge: {}\n")
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

it("refuses before claim when the mutable implementation root changes under a live resident (22369)", async () => {
  const repo = await queueRepository()
  const resident = await createYrdHost({ cwd: repo })
  try {
    await resident.services.queue?.provision?.("main")
    expect(await resident.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })

    // PID 88083 survived this exact class in production: vendor/yrd moved
    // 35562d -> acca14 -> 35562d while the resident stayed alive, so lazy
    // imports could load a different revision than the startup capture.
    source.current = "git:acca14a7cc3fa6ebc44051f2f5752884653d62b6"
    const audit = await resident.services.queue?.auditEnvironment?.()
    expect(audit).toMatchObject({ findings: [{ code: "runtime-drift" }] })
    expect(audit?.findings[0]?.message).toContain(`loaded '${source.loaded}'`)
    expect(audit?.findings[0]?.message).toContain(`working tree '${source.current}'`)
    expect(audit?.findings[0]?.message).toContain(`pinned '${source.authoritative}'`)

    await expect(requireFreshInstalledBaseline(resident.services)).rejects.toMatchObject({
      failure: { kind: "refusal", code: "runtime-drift" },
    })

    // Match the live 15:58:07 -> 15:58:55 checkout window exactly: the
    // mutable root returns to the startup SHA, but the continuation cycle
    // inside the window already refused rather than silently claiming work.
    source.current = source.loaded
    expect(await resident.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
    await requireFreshInstalledBaseline(resident.services)
  } finally {
    await resident.close()
  }
})

it("refuses before claim when authoritative native source advances under a live resident (22366)", async () => {
  const repo = await queueRepository()
  const resident = await createYrdHost({ cwd: repo })
  try {
    await resident.services.queue?.provision?.("main")
    expect(await resident.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })

    // The process remains alive with the construction-time source while a
    // freshly fetched authority leg observes the new Yrd gitlink.
    source.authoritative = "git:748dbd87dd6a30a5d4f41de4459b01d8014d791f"
    const configAudit = await resident.services.queue?.auditEnvironment?.()
    expect(configAudit).toMatchObject({
      findings: [{ code: "config-drift" }],
    })
    expect(configAudit?.findings[0]?.message).toContain(`loaded '${source.loaded}'`)
    expect(configAudit?.findings[0]?.message).toContain(`working tree '${source.current}'`)
    expect(configAudit?.findings[0]?.message).toContain(`pinned '${source.authoritative}'`)

    // Follow mode migrates the persisted baseline through the one provision
    // path, then the same gate must expose the still-loaded runtime and refuse
    // before queue.run gets a chance to claim work.
    const refusal = requireFreshInstalledBaseline(resident.services, { reloadInPlace: { base: "main" } })
    await expect(refusal).rejects.toMatchObject({
      failure: { kind: "refusal", code: "runtime-drift" },
    })
    await expect(refusal).rejects.toThrow(source.loaded)
    await expect(refusal).rejects.toThrow(source.authoritative)
    const runtimeAudit = await resident.services.queue?.auditEnvironment?.()
    expect(runtimeAudit).toMatchObject({
      findings: [{ code: "runtime-drift" }],
    })
    expect(runtimeAudit?.findings[0]?.message).toContain(`loaded '${source.loaded}'`)
    expect(runtimeAudit?.findings[0]?.message).toContain(`working tree '${source.current}'`)
    expect(runtimeAudit?.findings[0]?.message).toContain(`pinned '${source.authoritative}'`)
  } finally {
    await resident.close()
  }

  source.loaded = source.authoritative
  source.current = source.authoritative
  await using restarted = await createYrdHost({ cwd: repo })
  expect(await restarted.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
  await requireFreshInstalledBaseline(restarted.services)
})
