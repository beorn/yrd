/**
 * @failure Recut refused `payload-mismatch` when the rebase correctly dropped a patch-equivalent commit, and wedged the drain on a fully absorbed branch (22373).
 * @level l2
 * @consumer @yrd/queue Git PR remerger
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { createGitChangeRemerger, type ChangeRemergeResult } from "@yrd/queue"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

const seeded = (file: string) => Array.from({ length: 20 }, (_unused, index) => `${file} line ${index + 1}\n`).join("")

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, file), content)
  await git(repo, ["add", file])
  await git(repo, ["commit", "-qm", message])
  return git(repo, ["rev-parse", "HEAD"])
}

/** Append a line to an existing tracked file and commit it. */
async function append(repo: string, file: string, line: string, message: string): Promise<string> {
  const current = await readFile(join(repo, file), "utf8")
  return commit(repo, file, `${current}${line}\n`, message)
}

async function changedPaths(repo: string, from: string, to: string): Promise<string[]> {
  const output = await git(repo, ["diff", "--name-only", from, to])
  return output === "" ? [] : output.split("\n").toSorted()
}

/**
 * A root repo on `main` seeding `AGENTS.md`, `CLAUDE.md` and `hab.yml`, plus an
 * `issue/feature` branch carrying one ordinary commit per file — the PR1646
 * shape: three commits, three payload paths.
 */
async function featureRepo(): Promise<{ repo: string; sourceBase: string; headSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-recut-absorbed-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  for (const file of ["AGENTS.md", "CLAUDE.md", "hab.yml"]) await commit(repo, file, seeded(file), `root: ${file}`)
  const sourceBase = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  await append(repo, "AGENTS.md", "authored agents", "feat: agents")
  await append(repo, "CLAUDE.md", "authored claude", "feat: claude")
  const headSha = await append(repo, "hab.yml", "authored hab", "feat: hab")
  await git(repo, ["switch", "-q", "main"])
  return { repo, sourceBase, headSha }
}

/** Merge the named feature commits on `main` by another route, exactly as authored. */
async function landOnMain(repo: string, subjects: readonly string[]): Promise<string> {
  for (const subject of subjects) {
    const sha = await git(repo, ["rev-list", "-1", "--fixed-strings", `--grep=${subject}`, "issue/feature"])
    await git(repo, ["cherry-pick", sha])
  }
  return git(repo, ["rev-parse", "HEAD"])
}

async function remerge(
  repo: string,
  sourceBase: string,
  headSha: string,
  current?: Readonly<{ revision: number; headSha: string; baseSha: string; treeSha: string; patchId: string }>,
): Promise<ChangeRemergeResult> {
  await using process = createProcess()
  return await createGitChangeRemerger({ inject: { process }, repo }).recut({
    id: "PR1",
    branch: "issue/feature",
    base: "main",
    revision: 1,
    headSha,
    baseSha: sourceBase,
    ...(current === undefined ? {} : { current }),
  })
}

describe("recut against a base that absorbed part of the payload (22373)", () => {
  it("succeeds carrying only the paths the base did not already merge", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    const target = await landOnMain(repo, ["feat: agents", "feat: claude"])

    const result = await remerge(repo, sourceBase, headSha)

    expect(result.unchanged).toBe(false)
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(target)
    expect(await changedPaths(repo, target, result.headSha)).toEqual(["hab.yml"])
    // Every authored line is delivered — the absorbed two by the base, the third by this recut.
    for (const [file, line] of [
      ["AGENTS.md", "authored agents"],
      ["CLAUDE.md", "authored claude"],
      ["hab.yml", "authored hab"],
    ] as const) {
      expect(await git(repo, ["show", `${result.headSha}:${file}`])).toBe(`${seeded(file)}${line}`)
    }
  })

  it("reaches an already-landed head when the base absorbed the whole payload", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    const target = await landOnMain(repo, ["feat: agents", "feat: claude", "feat: hab"])

    const result = await remerge(repo, sourceBase, headSha)

    // Nothing is left to deliver: the recut head IS the base, so the merge
    // step's tree-equality proof closes the change as already-landed instead of
    // wedging the drain on a payload refusal.
    expect(result.headSha).toBe(target)
    expect(result.baseSha).toBe(target)
    expect(result.treeSha).toBe(await git(repo, ["rev-parse", `${target}^{tree}`]))
    expect(await changedPaths(repo, target, result.headSha)).toEqual([])
  })

  it("re-derives an already-landed revision instead of refusing its absent patch certificate", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    const target = await landOnMain(repo, ["feat: agents", "feat: claude", "feat: hab"])
    const first = await remerge(repo, sourceBase, headSha)

    // `target..head` is empty for an already-landed head, so the fast path has
    // no patch identity to certify against and must re-derive from the source.
    const again = await remerge(repo, sourceBase, headSha, {
      revision: 1,
      headSha: first.headSha,
      baseSha: first.baseSha,
      treeSha: first.treeSha,
      patchId: first.patchId,
    })

    expect(again.headSha).toBe(target)
    expect(again.patchId).toBe(first.patchId)
    expect(again.treeSha).toBe(first.treeSha)
  })

  it("still expects a payload path the base merely touched without absorbing", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    // The base rewrites AGENTS.md's first line — content the author never
    // wrote, far enough from the authored append at the end of the file that
    // both the merge and the authored patch identity survive. That path is NOT
    // absorbed and must stay in the expected payload.
    await commit(
      repo,
      "AGENTS.md",
      seeded("AGENTS.md").replace("AGENTS.md line 1\n", "AGENTS.md upstream line 1\n"),
      "base: agents preamble",
    )
    const target = await commit(repo, "unrelated.md", "unrelated\n", "base: unrelated")

    const result = await remerge(repo, sourceBase, headSha)

    expect(await changedPaths(repo, target, result.headSha)).toEqual(["AGENTS.md", "CLAUDE.md", "hab.yml"])
  })
})
