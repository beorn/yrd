/**
 * @failure The queue lands an authored gitlink verbatim while that submodule's main has
 *          already moved past it, so the merged root pins a commit that is not the newest
 *          commit on the submodule's main — or the fill-in write rewrites values it has no
 *          authority over (queue-composed submodule commits, intent targets).
 * @level l2
 * @consumer @yrd/queue candidate preparer — step (b)'s composition-time shaset write
 *
 * The shaset model: an authored gitlink is a min commit, a floor. At candidate composition
 * the queue resolves that submodule's main; when main contains the floor, the carrier
 * composes — the content merges as authored, and a queue-written shaset commit on top
 * fills each submodule value in from its main, recorded as a submodule resolution, so
 * checks judge THAT tree and authored values never land as-is. A min commit not on its
 * submodule's main keeps the authored-gitlink refusal (the composition-side backstop until
 * step (d) deletes it). Queue-composed submodule commits are by construction never on
 * main and ride verbatim — the fill-in never touches the composed leg.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { createProcess, shellCommand } from "@yrd/process"
import {
  GitCheckEvidenceSchema,
  Queues,
  assertComponentModelAuthorizationsAvailable,
  gitCandidatePreparer,
  gitCheckStep,
  type CandidatePreparationInput,
  type StepExecution,
} from "@yrd/queue"

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

async function gitlinkAt(repo: string, ref: string, path = "dep"): Promise<string> {
  return git(repo, ["ls-tree", "--format=%(objectname)", ref, "--", path])
}

/** A superproject pinning submodule `dep` at module commit A, whose module repo
 * ("origin" for the dep checkout) can move its main per test. */
async function baseRepo(): Promise<{ repo: string; module: string; moduleA: string; rootBase: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-composition-fill-in-"))
  roots.push(root)
  const repo = join(root, "repo")
  const module = join(root, "module")
  await Bun.$`git init -q -b main ${module}`
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await git(module, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  await writeFile(join(module, "version.txt"), "a\n")
  await git(module, ["add", "version.txt"])
  await git(module, ["commit", "-qm", "module a"])
  const moduleA = await git(module, ["rev-parse", "HEAD"])

  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await git(repo, ["config", "protocol.file.allow", "always"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "root"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dep at a"])
  const rootBase = await git(repo, ["rev-parse", "HEAD"])
  return { repo, module, moduleA, rootBase }
}

/** Commit a module change on `branch` (created at `from` if missing) and return its sha. */
async function moduleCommit(module: string, branch: string, from: string, value: string): Promise<string> {
  await git(module, ["checkout", "-q", "-B", branch, from])
  await writeFile(join(module, "version.txt"), `${value}\n`)
  await git(module, ["commit", "-qam", `module ${value}`])
  return git(module, ["rev-parse", "HEAD"])
}

/** Author a carrier commit that bumps `dep` to `minCommit` (the floor) plus a content file. */
async function authoredCarrier(repo: string, rootBase: string, minCommit: string): Promise<string> {
  await git(repo, ["switch", "-qc", "issue/feature", rootBase])
  await git(repo, ["update-index", "--cacheinfo", `160000,${minCommit},dep`])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: bump dep + feature"])
  const head = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["-c", "submodule.recurse=false", "switch", "-q", "main"])
  return head
}

function preparation(
  rootBase: string,
  headSha: string,
  props?: Readonly<Record<string, string>>,
): CandidatePreparationInput {
  return {
    id: "C1",
    queueId: "refs/heads/main",
    baseSha: rootBase,
    revs: [{ pr: "PR1", n: 1, head: headSha }],
    prs: [
      {
        id: "PR1",
        changeId: `I${"a".repeat(40)}`,
        branch: "issue/feature",
        base: "main",
        revision: 1,
        headSha,
        baseSha: rootBase,
        ...(props === undefined ? {} : { props }),
      },
    ],
  }
}

async function deletionCarrier(repo: string, rootBase: string): Promise<string> {
  await git(repo, ["switch", "-qc", "issue/remove-dep", rootBase])
  await git(repo, ["rm", "-q", "dep"])
  await git(repo, ["rm", "-q", "-f", ".gitmodules"])
  await writeFile(join(repo, "feature.txt"), "remove obsolete component\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: remove dep + cleanup"])
  const head = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return head
}

describe("authored-gitlink fill-in — the queue writes the shaset from each submodule's main", () => {
  it("spends a ruling on one immutable revision while keeping its retries idempotent", () => {
    const ruling = "195c96a6-a461-4c98-a97d-5537e76aa9fd"
    const authorization = {
      operation: "remove" as const,
      path: "dep",
      ruling,
      authorizer: "@cto",
      pr: "PR1",
      revision: 1,
      headSha: "a".repeat(40),
      patchId: "d".repeat(40),
    }
    const queues = Queues.empty({ batchSize: 1 })
    const spent = {
      ...queues,
      candidates: {
        C1: {
          id: "C1",
          queueId: "refs/heads/main",
          baseSha: "b".repeat(40),
          revs: [{ pr: "PR1", n: 1, head: "a".repeat(40) }],
          componentModelChanges: [authorization],
          mergeability: "mergeable" as const,
          createdAt: "2026-08-21T00:00:00.000Z",
        },
      },
    }

    expect(() =>
      assertComponentModelAuthorizationsAvailable(spent, { componentModelChanges: [authorization] }),
    ).not.toThrow()
    const recut = {
      ...authorization,
      revision: 2,
      headSha: "c".repeat(40),
      source: {
        repo: ".",
        fromHeadSha: authorization.headSha,
        toHeadSha: "c".repeat(40),
        patchId: authorization.patchId,
        rangeDiff: "=" as const,
      },
    }
    expect(() => assertComponentModelAuthorizationsAvailable(spent, { componentModelChanges: [recut] })).not.toThrow()
    const error = (() => {
      try {
        assertComponentModelAuthorizationsAvailable(spent, {
          componentModelChanges: [{ ...authorization, pr: "PR2", headSha: "c".repeat(40) }],
        })
      } catch (thrown) {
        return thrown
      }
      return undefined
    })()
    expect(failureFact(error)).toMatchObject({ kind: "refusal", code: "component-model-ruling-spent" })
  })

  it("admits an exact verdict-backed component deletion and records its one-shot evidence", async () => {
    const { repo, rootBase } = await baseRepo()
    const headSha = await deletionCarrier(repo, rootBase)
    const ruling = "195c96a6-a461-4c98-a97d-5537e76aa9fd"
    const requests: unknown[] = []
    await using process = createProcess({ cwd: repo })

    const prepared = await gitCandidatePreparer({
      inject: { process },
      repo,
      authorizeComponentModelChange: async (request) => {
        requests.push(request)
        return { authorizer: "@cto" }
      },
    })(preparation(rootBase, headSha, { "component-model-change": `remove dep; ruling ${ruling}` }))

    expect(requests).toEqual([
      {
        operation: "remove",
        path: "dep",
        ruling,
        pr: "PR1",
        revision: 1,
        headSha,
        patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      },
    ])
    expect(prepared.componentModelChanges).toEqual([
      {
        operation: "remove",
        path: "dep",
        ruling,
        authorizer: "@cto",
        pr: "PR1",
        revision: 1,
        headSha,
        patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      },
    ])
    expect(prepared.sha).toBeDefined()
    expect(await gitlinkAt(repo, prepared.sha as string)).toBe("")
    expect(await git(repo, ["show", `${prepared.sha as string}:feature.txt`])).toBe("remove obsolete component")
  })

  it("refuses a component deletion when the ruling prop is absent or the host cannot resolve it", async () => {
    const { repo, rootBase } = await baseRepo()
    const headSha = await deletionCarrier(repo, rootBase)
    await using process = createProcess({ cwd: repo })

    for (const props of [
      undefined,
      { "component-model-change": "remove dep; ruling 195c96a6-a461-4c98-a97d-5537e76aa9fd" },
    ]) {
      const error = await Promise.resolve(
        gitCandidatePreparer({ inject: { process }, repo })(preparation(rootBase, headSha, props)),
      ).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(failureFact(error)?.code).toMatch(/^(?:authored-gitlink|component-model-authorizer-unavailable)$/u)
    }
  })

  it("fills in main's newest commit past the authored floor, as one gitlinks-only shaset commit", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    // The floor landed on the submodule's main, and main moved further.
    const moduleB = await moduleCommit(module, "main", moduleA, "b")
    const moduleM = await moduleCommit(module, "main", moduleB, "m")
    const headSha = await authoredCarrier(repo, rootBase, moduleB)

    await using process = createProcess({ cwd: repo })
    const prepared = await gitCandidatePreparer({ inject: { process }, repo })(preparation(rootBase, headSha))

    expect(prepared.mergeability).toBe("mergeable")
    if (prepared.mergeability !== "mergeable" || prepared.sha === undefined) throw new Error("unreachable")
    // The candidate pins the newest commit on the submodule's main, not the floor...
    expect(await gitlinkAt(repo, prepared.sha)).toBe(moduleM)
    // ...while the authored content rides through the ordinary merge.
    expect(await git(repo, ["show", `${prepared.sha}:feature.txt`])).toBe("feature")
    // The filled value is recorded as a submodule resolution — the final word the
    // merge-time validator and the merge record both read for this path.
    expect(prepared.submoduleResolutions).toEqual([{ kind: "pin", path: "dep", sha: moduleM }])
    // The shaset-commit species invariant: the queue's own write sits on top of
    // the content merge and its diff is exactly the gitlink it filled in.
    expect(await git(repo, ["diff", "--name-only", `${prepared.sha}^`, prepared.sha])).toBe("dep")
    // The recorded change points at the shaset commit, so checks judge that tree.
    expect(prepared.changes?.[0]?.generatedCommit).toBe(prepared.sha)
  })

  it("composes without a shaset commit when the floor already IS main's newest commit", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "main", moduleA, "b")
    const headSha = await authoredCarrier(repo, rootBase, moduleB)

    await using process = createProcess({ cwd: repo })
    const prepared = await gitCandidatePreparer({ inject: { process }, repo })(preparation(rootBase, headSha))

    expect(prepared.mergeability).toBe("mergeable")
    if (prepared.mergeability !== "mergeable" || prepared.sha === undefined) throw new Error("unreachable")
    expect(await gitlinkAt(repo, prepared.sha)).toBe(moduleB)
    // Nothing was filled in past the floor: no resolution row, no extra commit.
    expect(prepared.submoduleResolutions).toBeUndefined()
  })

  it("keeps the authored-gitlink refusal for a min commit that is not on its submodule's main", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    // The floor lives only on a side branch: submodule-main-first is not met.
    const moduleB = await moduleCommit(module, "feature", moduleA, "b")
    const headSha = await authoredCarrier(repo, rootBase, moduleB)

    await using process = createProcess({ cwd: repo })
    const error = await Promise.resolve(
      gitCandidatePreparer({ inject: { process }, repo })(preparation(rootBase, headSha)),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    const fact = failureFact(error)
    if (fact === undefined) throw new Error(`expected a typed refusal, got ${String(error)}`)
    // The composition-side backstop until step (d): same code, same shape.
    expect(fact.code).toBe("authored-gitlink")
    expect(fact.message).toContain("dep")
  })

  it("hands checks the filled tree: the sha a step judges is the shaset commit, never the author head", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "main", moduleA, "b")
    const moduleM = await moduleCommit(module, "main", moduleB, "m")
    const headSha = await authoredCarrier(repo, rootBase, moduleB)

    await using process = createProcess({ cwd: repo })
    const input: StepExecution = {
      run: "R1",
      step: "check",
      index: 0,
      prs: preparation(rootBase, headSha).prs,
      shape: { results: {} },
    }
    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      // The step passes only when the sha it is handed IS the tree it stands in,
      // and the PR-identity variable stays the author head — two different facts,
      // never conflated: YRD_SHA names the revision, YRD_CANDIDATE_SHA/YRD_TARGET
      // name the judged tree.
      command: shellCommand(
        'test "$YRD_CANDIDATE_SHA" = "$(git rev-parse HEAD)" && ' +
          'test "$YRD_TARGET" = "$YRD_CANDIDATE_SHA" && ' +
          'test "$YRD_SHA" != "$YRD_CANDIDATE_SHA"',
      ),
    })(input, { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal })

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    if (outcome.status !== "completed" || outcome.conclusion !== "success") throw new Error("unreachable")
    const evidence = GitCheckEvidenceSchema.parse(outcome.output)
    // The judged tree carries the filled submodule value — checks ran against the
    // shaset the queue wrote, not the floor the author committed...
    expect(await gitlinkAt(repo, evidence.candidateSha)).toBe(moduleM)
    // ...and never against the author head.
    expect(evidence.candidateSha).not.toBe(headSha)
  })
})
