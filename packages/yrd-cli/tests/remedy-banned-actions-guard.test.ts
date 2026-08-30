/**
 * @failure  A remedy/refusal string anywhere in the yrd tool surface tells its
 *           reader to run a git command the project's merge-path rules
 *           forbid — a hand-push to a submodule's `refs/heads/*`, a
 *           cherry-pick onto a merge path, `--force-with-lease`, or
 *           destructive git (`reset --hard` / `stash` / `checkout .` /
 *           `clean -f`) against a checkout the guard has not proven is the
 *           pipeline's own ephemeral worktree. An operator who follows the
 *           printed line LITERALLY is correct behavior; the defect is the
 *           text. @i/10-merge-queue/remedy-instructs-banned-action.
 * @level    l1 (pure static scan of this repo's own checked-out source; no
 *           subprocess, no network)
 * @consumer @i/10-merge-queue/remedy-instructs-banned-action
 *
 * DESIGNED HOME: this file is written to
 * `/hh/vendor/yrd/packages/yrd-cli/tests/remedy-banned-actions-guard.test.ts`
 * — colocated with `yrd-cli`, which owns 5 of the 5 confirmed offenders as of
 * 2026-08-13 (`intent-admission.ts` x4, `run.ts` x1) — but it scans every
 * package's `src/` tree (every nested `.ts` file under `packages/<pkg>/src/`),
 * not just yrd-cli's own, since a future offender can merge in any package. Drop it at that path
 * unmodified; `import.meta.dirname` walks up 3 levels (`tests/` -> `yrd-cli/` ->
 * `packages/` -> repo root) to find `packages/<pkg>/src`, so it is location-sensitive to
 * exactly that depth.
 *
 * EXPECTED RED at HEAD as of 2026-08-13, by design (reproduce-first): the 5
 * confirmed offenders below are still live. Merge the guard together with (or
 * immediately before) their fix — see the sweep's `patch-plan.md` — so this
 * test is the regression fence, not a report.
 *
 * ALLOWLIST covers the pipeline's own internal git actuation (never printed
 * to a human as advice) — see each entry's `reason`. Do not add a new
 * remedy/refusal site to the allowlist; if a new hit is a genuine internal
 * actuation, its reason must say WHERE it is invoked from and WHY that
 * caller is not a human reading a refusal message.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(import.meta.dirname, "../../../")
const PACKAGES_ROOT = join(REPO_ROOT, "packages")

type Allowed = Readonly<{ file: string; reason: string }>

/** Repo-relative (from `packages/`) file paths whose banned-pattern hits are
 * proven internal pipeline actuation, not remedy/refusal text shown to a
 * human. Every entry earns its place in `findings.md` of the 2026-08-13
 * sweep — re-derive, never assume, before adding to this list. */
const ALLOWLIST: readonly Allowed[] = [
  {
    file: "yrd-queue/src/candidate-pool.ts",
    reason:
      "reset --hard / clean -fdx run only against the pipeline's own ephemeral candidate-pool worktree to prove " +
      "it residue-free before reuse — never a submodule's canonical checkout, never shared main, never printed " +
      "to a human.",
  },
  {
    file: "yrd-queue/src/command.ts",
    reason:
      "rebuildCandidateByMerge resets only its pipeline-owned ephemeral withScratch worktree after a clean " +
      "trial merge, before the authoritative merge runs — never a canonical checkout and never printed to a human.",
  },
  {
    file: "yrd-bay/src/git.ts",
    reason:
      "Bay workspace checkpoint pushes a change's own branch (HEAD:refs/heads/<branch>) as part of provisioning — " +
      "pipeline actuation, not printed advice.",
  },
  {
    file: "yrd-cli/src/gitlink-advance.ts",
    reason:
      "Both `refs/heads` pushes are `yrd gitlink advance`'s own actuation, invoked from " +
      "`advanceSubmoduleGitlink` in run.ts and never printed to anyone. `publishMinCommit` fast-forwards the " +
      "submodule's own main to a commit the plan already proved descends from it — the direct push submodules " +
      "get because they are `landing: none`, and it runs only when the operand named a commit main does not " +
      "already carry. `pushGitlinkAdvanceBranch` publishes the advance's own fresh branch (HEAD:refs/heads/" +
      "<branch>) so `pr submit` has a ref to record — the same shape, and the same reason, as the allowlisted " +
      "Bay checkpoint push in yrd-bay/src/git.ts. Neither is a force, a lease override, or a merge-path write; " +
      "this file's remedy strings name only `git log` and `git fetch`.",
  },
  {
    file: "yrd-cli/src/bay-status.ts",
    reason:
      "Its only 'git stash' hit is the diagnostic evidence string \"could not inspect git stash list\" — it " +
      "reports an inspection FAILURE, never instructs running `git stash`. A genuine descriptive (not " +
      "prescriptive) use; re-check on any future edit to this file that this stays true.",
  },
]

const BANNED_PATTERNS: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  // The two confirmed specimen shapes: `git push … refs/heads/…`, as inline
  // shell text or as a RemedyStepV1 argv array.
  { name: "git-push-to-refs/heads (inline text)", pattern: /\bgit\b[^\n]{0,60}\bpush\b[^\n]{0,120}refs\/heads\// },
  { name: "git-push-to-refs/heads (argv array)", pattern: /"git"\s*,\s*"push"[^\]]{0,160}refs\/heads\// },
  { name: "cherry-pick", pattern: /\bgit\b[^\n]{0,40}cherry-pick\b/ },
  { name: "force-with-lease", pattern: /--force-with-lease/ },
  { name: "reset --hard", pattern: /\bgit\b[^\n]{0,20}\breset\b[^\n]{0,10}--hard\b|"reset"\s*,\s*"--hard"/ },
  { name: "git stash", pattern: /\bgit\s+stash\b/ },
  { name: "destructive checkout .", pattern: /\bgit\s+checkout\s+\.\s*(\n|$|["'`])/ },
  { name: "clean -f", pattern: /\bgit\s+clean\s+-f|"clean"\s*,\s*"-f/ },
]

/**
 * A SECOND ban, structurally distinct from the single-line scan above: not a
 * banned git action, but a banned PAIRING inside one `resolution`/`remedy`
 * array — offering irreversible `--burn-payload` disposal as a co-equal cure
 * alongside reversible `submit`. That is the exact shape `1739d38a`
 * ("fix(queue): remove destructive draft remedy") pulled out of the
 * `draft-stranded` finding's `resolution` array
 * (@i/10-yrd/drafts-strand-silently box (b), chief class ruling 2026-08-16:
 * "a draft is its AUTHOR'S drain obligation… destruction is never a sibling
 * remedy to submission"). That fix landed with exactly one runtime regression
 * test, scoped to the one `queue audit` scenario that reaches it — nothing
 * stopped a DIFFERENT finding, or a future edit to this one, from
 * reintroducing the pairing. This is that fence: it reads the property
 * value, not a single line, so a `resolution: [...]` array split across
 * several lines (the shape every producer in this tree actually uses) is
 * still caught.
 *
 * A single-line regex cannot express this — the two entries live on
 * different lines of the same array literal — so it is checked separately
 * from `BANNED_PATTERNS` rather than folded into it.
 */
const RESOLUTION_ARRAY_PATTERN = /\b(?:resolution|remedy)\s*:\s*\[([\s\S]*?)\]/g
const SUBMIT_IN_RESOLUTION_PATTERN = /\bsubmit\b/
const BURN_PAYLOAD_IN_RESOLUTION_PATTERN = /--burn-payload/

/** Every `resolution:`/`remedy:` array literal in `content` that names both a
 * `submit` step and `--burn-payload` — reversible delivery and irreversible
 * disposal offered as siblings, the shape the ruling forbids. Returns one
 * `file:line: …` string per offending array, `line` counted from the start
 * of the array literal (matching how `BANNED_PATTERNS` reports offenders
 * above) so a hit points a reader at the exact `resolution:`/`remedy:` line. */
function findSiblingSubmitBurnPayloadOffenders(content: string, relativePath: string): readonly string[] {
  const offenders: string[] = []
  for (const match of content.matchAll(RESOLUTION_ARRAY_PATTERN)) {
    // The single capturing group always matches when the whole pattern does
    // — it is not inside an alternation or `?` quantifier — but TS types
    // every numbered group as possibly `undefined`, so this is a type
    // narrowing, not a real fallback: an empty body simply never contains
    // both banned substrings below.
    const body = match[1] ?? ""
    if (!SUBMIT_IN_RESOLUTION_PATTERN.test(body) || !BURN_PAYLOAD_IN_RESOLUTION_PATTERN.test(body)) continue
    const line = content.slice(0, match.index).split("\n").length
    offenders.push(
      `${relativePath}:${String(line)}: resolution/remedy array offers both submit and --burn-payload as sibling entries`,
    )
  }
  return offenders
}

/** Repo-relative (from `packages/`) path, forward-slashed, for stable matching
 * regardless of platform separator. */
function relativeToPackages(absolutePath: string): string {
  return absolutePath.slice(PACKAGES_ROOT.length + 1).replaceAll("\\", "/")
}

function listSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue
      listSourceFiles(path, out)
      continue
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue
    out.push(path)
  }
}

/** Every `src/` file across every package — the whole yrd tool surface this
 * bead's acceptance criterion names, never a hand-picked subset. */
function surfaceFiles(): readonly string[] {
  const files: string[] = []
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    const srcDir = join(PACKAGES_ROOT, pkg, "src")
    try {
      if (!statSync(srcDir).isDirectory()) continue
    } catch {
      continue // no src/ dir in this package
    }
    listSourceFiles(srcDir, files)
  }
  // A sweep that silently scanned zero files would pass every check below
  // without proving anything — the same failure class this guard exists to
  // prevent in the surface it watches.
  if (files.length === 0) {
    throw new Error("remedy-banned-actions-guard: enumerated no source files under packages/*/src")
  }
  return files
}

describe("yrd tool surface: no remedy prescribes a banned git action", () => {
  it("scans every package's src/, not a hand-picked subset", () => {
    const files = surfaceFiles()
    const packagesTouched = new Set(files.map((f) => relativeToPackages(f).split("/")[0]))
    // 2026-08-13 sweep denominator: 11 packages carry a src/ dir. A drop
    // below this without a deliberate edit here means the walk broke, not
    // that packages disappeared.
    expect(packagesTouched.size).toBeGreaterThanOrEqual(10)
  })

  for (const { name, pattern } of BANNED_PATTERNS) {
    it(`flags every non-allowlisted '${name}' hit`, () => {
      const offenders: string[] = []
      for (const absolutePath of surfaceFiles()) {
        const relative = relativeToPackages(absolutePath)
        if (ALLOWLIST.some((entry) => entry.file === relative)) continue
        const content = readFileSync(absolutePath, "utf8")
        const lines = content.split("\n")
        lines.forEach((line, index) => {
          if (pattern.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
        })
      }
      expect(offenders, `banned pattern '${name}' found outside the allowlist:\n${offenders.join("\n")}`).toEqual([])
    })
  }

  it("keeps every allowlist entry pointed at a real file", () => {
    for (const entry of ALLOWLIST) {
      expect(
        () => statSync(join(PACKAGES_ROOT, entry.file)),
        `allowlisted file is missing: ${entry.file}`,
      ).not.toThrow()
    }
  })

  // Pinned red/green proof for `findSiblingSubmitBurnPayloadOffenders`
  // itself, independent of what the live tree currently contains: a fixture
  // detector test needs its own positive control, or a vacuous regex (one
  // that matches nothing, ever) would report "0 offenders" for the same
  // reason a real fix does. `BAD_FIXTURE` below is not invented — it is the
  // exact `resolution` array `1739d38a` removed from the `draft-stranded`
  // finding in `yrd-queue/src/queue.ts` (@i/10-yrd/drafts-strand-silently
  // box (b)), reproduced here as a plain string so the guard's own test does
  // not depend on git history to stay meaningful.
  it("detector: fires on the exact array the 2026-08-19 fix removed, clears on its replacement", () => {
    const BAD_FIXTURE = [
      "      findings.push({",
      '        code: "draft-stranded",',
      "        resolution: [",
      "          `yrd pr submit ${pr.branch} --issue <ref>`,",
      "          `or withdraw it: yrd pr withdraw ${pr.id} --burn-payload`,",
      "        ],",
      "      })",
    ].join("\n")
    expect(findSiblingSubmitBurnPayloadOffenders(BAD_FIXTURE, "fixture.ts")).toEqual([
      "fixture.ts:3: resolution/remedy array offers both submit and --burn-payload as sibling entries",
    ])

    // Negative control: the actual replacement text, submit alone, must not trip it.
    const FIXED_FIXTURE = [
      "      findings.push({",
      '        code: "draft-stranded",',
      "        resolution: [`yrd pr submit ${pr.branch} --issue <ref>`],",
      "      })",
    ].join("\n")
    expect(findSiblingSubmitBurnPayloadOffenders(FIXED_FIXTURE, "fixture.ts")).toEqual([])

    // A withdraw-only array (no submit alongside it) is a different, legal
    // shape — e.g. `remedy-admissibility.ts`'s `disposalRemedy`, chosen
    // exclusively for a branch already absent from origin with nothing left
    // to submit. Only the SIBLING pairing is banned.
    const WITHDRAW_ONLY_FIXTURE = 'resolution: [`yrd pr withdraw ${pr.id} --burn-payload --reason "..."`]'
    expect(findSiblingSubmitBurnPayloadOffenders(WITHDRAW_ONLY_FIXTURE, "fixture.ts")).toEqual([])
  })

  it("no resolution/remedy array in the live surface offers --burn-payload as a sibling to submit", () => {
    const offenders: string[] = []
    for (const absolutePath of surfaceFiles()) {
      const relative = relativeToPackages(absolutePath)
      const content = readFileSync(absolutePath, "utf8")
      offenders.push(...findSiblingSubmitBurnPayloadOffenders(content, relative))
    }
    expect(
      offenders,
      `a resolution/remedy array offers --burn-payload beside submit — destruction is never a sibling remedy to ` +
        `submission (chief class ruling 2026-08-16, @i/10-yrd/drafts-strand-silently):\n${offenders.join("\n")}`,
    ).toEqual([])
  })
})
