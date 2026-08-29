/**
 * Real-repository fixture builders for the re-merge refactor (Phase 1).
 *
 * Each builder constructs genuine git history in a fresh temp directory and
 * returns the paths and shas a test needs — facts only. The builders are
 * mechanism-agnostic on purpose: they know nothing about queues, rebuild
 * machinery or refusals, so any phase can point its own mechanism at them.
 * They import NOTHING from src; the assertions belong to the tests.
 *
 * Ownership: every builder returns `root`, the temp directory that owns every
 * other path in the fixture. The CALLER removes it (the suites' usual
 * `roots.push(fixture.root)` + afterEach `rm` idiom).
 *
 * The three specimens:
 *  - `movedBaseFixture` — a change authored on base B1 while main advanced to
 *    B2, with disjoint-path, overlapping-path-mergeable and
 *    overlapping-path-conflicting variants of what B1..B2 touched.
 *  - `bothSidesMovedGitlinkFixture` — a superproject where the author's branch
 *    and main both moved the SAME submodule gitlink to different shas.
 *  - `emptyCandidateFixture` — the 23167 specimen: two sibling changes each
 *    containing commit X's change (one via revert-then-restore history), such
 *    that after the first merges, rebuilding the second against the new base
 *    yields an EMPTY candidate — commit counting still reports unique work,
 *    the tree tuple reports none.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FIXTURE_ENV = {
  GIT_AUTHOR_NAME: "Yrd Test",
  GIT_AUTHOR_EMAIL: "yrd@example.invalid",
  GIT_COMMITTER_NAME: "Yrd Test",
  GIT_COMMITTER_EMAIL: "yrd@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
} as const

async function execGit(
  repo: string,
  args: readonly string[],
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...FIXTURE_ENV },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/**
 * Repository handle over the fixture's own env-hardened git, structurally
 * compatible with the package's exported `RefGit` (`text` throws on non-zero,
 * `optionalText` answers undefined instead), plus `exec` for the assertions that
 * need the exit code itself (e.g. proving a merge CONFLICTS).
 */
export type FixtureGit = Readonly<{
  text(repo: string, args: readonly string[]): Promise<string>
  optionalText(repo: string, args: readonly string[]): Promise<string | undefined>
  exec(repo: string, args: readonly string[]): Promise<Readonly<{ code: number; stdout: string; stderr: string }>>
}>

export function fixtureRefGit(): FixtureGit {
  return {
    async text(repo, args) {
      const result = await execGit(repo, args)
      if (result.code !== 0) {
        throw new Error(`git -C ${repo} ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`)
      }
      return result.stdout
    },
    async optionalText(repo, args) {
      const result = await execGit(repo, args)
      return result.code === 0 ? result.stdout : undefined
    },
    exec: execGit,
  }
}

async function initRepo(root: string, name: string): Promise<string> {
  const git = fixtureRefGit()
  const repo = join(root, name)
  await git.text(root, ["init", "-b", "main", name])
  return repo
}

async function commitFile(repo: string, path: string, content: string, message: string): Promise<string> {
  const git = fixtureRefGit()
  await Bun.write(join(repo, path), content)
  await git.text(repo, ["add", "--", path])
  await git.text(repo, ["commit", "-m", message])
  return git.text(repo, ["rev-parse", "HEAD"])
}

async function commitGitlink(repo: string, path: string, oid: string, message: string): Promise<string> {
  const git = fixtureRefGit()
  await git.text(repo, ["update-index", "--add", "--cacheinfo", `160000,${oid},${path}`])
  await git.text(repo, ["commit", "-m", message])
  return git.text(repo, ["rev-parse", "HEAD"])
}

/** What main did between the author's base and its own new tip, relative to
 * the path the author touched. */
export type MovedBaseMainMoves = "disjoint-paths" | "overlapping-path-mergeable" | "overlapping-path-conflicting"

export type MovedBaseFixture = Readonly<{
  /** Temp directory owning everything below; the caller removes it. */
  root: string
  repo: string
  /** B1 — the base the author's change was written on. */
  baseOne: string
  /** B2 — where main's history stands now; B1 is an ancestor of B2. */
  baseTwo: string
  /** Tip of the author's branch; its parent is B1. */
  authorTip: string
  authorBranch: string
  /** The path the author's change touches. */
  authorPath: string
  /** The paths B1..B2 touched on main. */
  mainPaths: readonly string[]
  variant: MovedBaseMainMoves
}>

const SHARED_FILE = "shared.txt"
const SHARED_LINES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] as const

function sharedContent(overrides: Readonly<Record<number, string>>): string {
  return `${SHARED_LINES.map((line, index) => overrides[index] ?? line).join("\n")}\n`
}

/**
 * A change authored on base B1 while main advanced to B2.
 *
 *   B1 --- mainMove --- B2        (main)
 *     \
 *      -- authorTip             (task/moved-base-author)
 *
 * - disjoint-paths: main's move touches only its own file.
 * - overlapping-path-mergeable: main edits the SAME file the author edits, in
 *   a distant region — path-level overlap that content-level merging resolves.
 * - overlapping-path-conflicting: main edits the same region of the same file,
 *   so a re-merge of the author's change against B2 conflicts.
 */
export async function movedBaseFixture(
  options: Readonly<{ mainMoves: MovedBaseMainMoves }>,
): Promise<MovedBaseFixture> {
  const git = fixtureRefGit()
  const root = await mkdtemp(join(tmpdir(), "yrd-moved-base-"))
  const repo = await initRepo(root, "repo")
  await commitFile(repo, SHARED_FILE, sharedContent({}), "base: shared file")
  const baseOne = await commitFile(repo, "main-only.txt", "main line one\n", "base: main-only file")

  const authorBranch = "task/moved-base-author"
  await git.text(repo, ["checkout", "-b", authorBranch, baseOne])
  // The author edits the TOP region of the shared file.
  const authorTip = await commitFile(
    repo,
    SHARED_FILE,
    sharedContent({ 0: "alpha (authored)" }),
    "author: edit shared top",
  )

  await git.text(repo, ["checkout", "main"])
  const mainPaths: string[] = options.mainMoves === "disjoint-paths" ? ["main-only.txt"] : [SHARED_FILE]
  const baseTwo =
    options.mainMoves === "disjoint-paths"
      ? await commitFile(repo, "main-only.txt", "main line one\nmain line two\n", "main: extend main-only file")
      : options.mainMoves === "overlapping-path-mergeable"
        ? // Main edits the BOTTOM region of the same file: overlapping path,
          // disjoint regions, so content-level merging still resolves it.
          await commitFile(repo, SHARED_FILE, sharedContent({ 7: "hotel (moved by main)" }), "main: edit shared bottom")
        : // Main edits the SAME top region the author edited: a real conflict.
          await commitFile(repo, SHARED_FILE, sharedContent({ 0: "alpha (moved by main)" }), "main: edit shared top")

  return {
    root,
    repo,
    baseOne,
    baseTwo,
    authorTip,
    authorBranch,
    authorPath: SHARED_FILE,
    mainPaths,
    variant: options.mainMoves,
  }
}

export type MovedGitlinkFixture = Readonly<{
  /** Temp directory owning everything below; the caller removes it. */
  root: string
  /** The superproject repository whose trees record the gitlink. */
  superRepo: string
  /** The submodule's own repository (a separate object store). */
  submoduleRepo: string
  /** Path of the gitlink inside the superproject tree. */
  gitlinkPath: string
  /** Submodule commit recorded by the superproject base. */
  baseGitlink: string
  /** Submodule commit main moved the gitlink to. */
  mainGitlink: string
  /** Submodule commit the author's branch moved the gitlink to. */
  authorGitlink: string
  /** Superproject base commit both sides started from. */
  baseSha: string
  /** Superproject main tip (gitlink at mainGitlink). */
  mainTip: string
  /** Superproject author-branch tip (gitlink at authorGitlink). */
  authorTip: string
  authorBranch: string
}>

/**
 * A superproject where the author's branch and main both moved the SAME
 * submodule gitlink — to different submodule commits that diverged from the
 * recorded base commit, so neither side contains the other.
 *
 * The gitlink is recorded through the index (`update-index --cacheinfo`), the
 * same way the superproject tree records it; the submodule's objects live in
 * their own repository and are deliberately NOT present in the superproject
 * object store — at the superproject tree level a gitlink is an opaque
 * recorded commit id.
 */
export async function bothSidesMovedGitlinkFixture(): Promise<MovedGitlinkFixture> {
  const git = fixtureRefGit()
  const root = await mkdtemp(join(tmpdir(), "yrd-moved-gitlink-"))

  const submoduleRepo = await initRepo(root, "submodule")
  const baseGitlink = await commitFile(submoduleRepo, "lib.txt", "s0\n", "submodule: s0")
  const mainGitlink = await commitFile(submoduleRepo, "lib.txt", "s0\ns1\n", "submodule: s1 (main's move)")
  await git.text(submoduleRepo, ["checkout", "-b", "author-side", baseGitlink])
  const authorGitlink = await commitFile(submoduleRepo, "author.txt", "s2\n", "submodule: s2 (author's move)")
  await git.text(submoduleRepo, ["checkout", "main"])

  const superRepo = await initRepo(root, "super")
  const gitlinkPath = "vendor/dep"
  await commitFile(
    superRepo,
    ".gitmodules",
    `[submodule "${gitlinkPath}"]\n\tpath = ${gitlinkPath}\n\turl = ../submodule\n`,
    "super: declare submodule",
  )
  const baseSha = await commitGitlink(superRepo, gitlinkPath, baseGitlink, "super: record gitlink at s0")
  const authorBranch = "task/moved-gitlink-author"
  await git.text(superRepo, ["checkout", "-b", authorBranch, baseSha])
  const authorTip = await commitGitlink(superRepo, gitlinkPath, authorGitlink, "super: author moves gitlink to s2")
  await git.text(superRepo, ["checkout", "main"])
  const mainTip = await commitGitlink(superRepo, gitlinkPath, mainGitlink, "super: main moves gitlink to s1")

  return {
    root,
    superRepo,
    submoduleRepo,
    gitlinkPath,
    baseGitlink,
    mainGitlink,
    authorGitlink,
    baseSha,
    mainTip,
    authorTip,
    authorBranch,
  }
}

export type EmptyCandidateFixture = Readonly<{
  /** Temp directory owning everything below; the caller removes it. */
  root: string
  repo: string
  /** B0 — the base both sibling branches started from. */
  base: string
  /** X — the change both siblings contain; authored on the first sibling. */
  commitX: string
  /** The second sibling's own copy of X's change (same patch, its own sha). */
  pickOfX: string
  /** The second sibling's revert of that copy. */
  revertOfX: string
  /** The second sibling's restore (revert of the revert). */
  restoreOfX: string
  /** Tip of the first sibling branch (== commitX). */
  firstTip: string
  /** Tip of the second sibling branch (== restoreOfX). */
  secondTip: string
  firstBranch: string
  secondBranch: string
  /** Main after merging the first sibling (--no-ff). */
  mainTip: string
  /** The file X changes. */
  path: string
}>

/**
 * The 23167 specimen.
 *
 *        --- X                          (sibling/first)
 *       /
 *   B0 ----- X' -- revert(X') -- restore  (sibling/second)
 *       \
 *        --- merge(first) = mainTip     (main)
 *
 * Both siblings contain the SAME content change (X and its patch-copy X'); the
 * second wraps its copy in revert-then-restore history, so its net tree effect
 * is X's change and nothing more. After the first sibling merges into main,
 * rebuilding the second against mainTip yields a candidate whose tree is
 * IDENTICAL to mainTip's — the empty candidate. Commit counting still sees the
 * revert and the restore as unique commits; only the tree tuple tells the
 * truth. Tests assert that emptiness with `exactDelta`.
 */
export async function emptyCandidateFixture(): Promise<EmptyCandidateFixture> {
  const git = fixtureRefGit()
  const root = await mkdtemp(join(tmpdir(), "yrd-empty-candidate-"))
  const repo = await initRepo(root, "repo")
  const path = "feature.txt"
  const base = await commitFile(repo, path, "before\n", "base: feature file")

  const firstBranch = "sibling/first"
  await git.text(repo, ["checkout", "-b", firstBranch, base])
  const commitX = await commitFile(repo, path, "after\n", "X: the shared change")
  const firstTip = commitX

  const secondBranch = "sibling/second"
  await git.text(repo, ["checkout", "-b", secondBranch, base])
  await git.text(repo, ["cherry-pick", commitX])
  const pickOfX = await git.text(repo, ["rev-parse", "HEAD"])
  await git.text(repo, ["revert", "--no-edit", pickOfX])
  const revertOfX = await git.text(repo, ["rev-parse", "HEAD"])
  await git.text(repo, ["revert", "--no-edit", revertOfX])
  const restoreOfX = await git.text(repo, ["rev-parse", "HEAD"])
  const secondTip = restoreOfX

  await git.text(repo, ["checkout", "main"])
  await git.text(repo, ["merge", "--no-ff", "-m", "merge the first sibling", firstTip])
  const mainTip = await git.text(repo, ["rev-parse", "HEAD"])

  return {
    root,
    repo,
    base,
    commitX,
    pickOfX,
    revertOfX,
    restoreOfX,
    firstTip,
    secondTip,
    firstBranch,
    secondBranch,
    mainTip,
    path,
  }
}
