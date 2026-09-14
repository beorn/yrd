/** One protected P/C lifecycle for queue phases and the non-publishing check command. */
import { lstatSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import { checkLogPath, runCheck, type CheckedTree, type CheckResult, type CheckSpec } from "./check.ts"
import { gitIn, refAt } from "./git.ts"
import type { Git } from "./records.ts"
import type { QueueRunLog } from "./log.ts"
import {
  checkedTree,
  judgedTreeDigest,
  prepareWorktree,
  SETUP,
  SetupFailed,
  type PrepareWorktree,
  type PreparedWorktree,
} from "./worktree.ts"

/** Execution inputs only: no queue steps, refs, publication or merge capability. */
export type ProgramRootCheck = Readonly<{
  git: Git
  repo: string
  targetSha: string
  tree: CheckedTree
  spec: CheckSpec
  branch: string
  head: string
  phase: string
  root: string
  logDir: string
  tmpdir: string
  log: QueueRunLog
  setup?: string
  extraEnv?: Readonly<Record<string, string>>
}> &
  Pick<PrepareWorktree, "env" | "process" | "selection" | "gitOptions" | "populateReference" | "plumbing">

/** The queue attributes candidate setup failures; check only reports them. */
export class ProgramSubjectSetupFailed extends Error {
  constructor(readonly setup: SetupFailed) {
    super(setup.message, { cause: setup })
    this.name = "ProgramSubjectSetupFailed"
  }
}

export async function validateScripts(
  run: Pick<ProgramRootCheck, "git" | "targetSha">,
  spec: CheckSpec,
): Promise<void> {
  const scripts = spec.scripts ?? []
  if (scripts.length === 0) return
  for (const path of scripts) {
    if (
      (await refAt(run.git, `${run.targetSha}:${path}`, "blob")) === undefined &&
      (await refAt(run.git, `${run.targetSha}:${path}`, "tree")) === undefined
    ) {
      throw new Error(
        `check ${spec.name} declares scripts: ${path}, which the target ${run.targetSha.slice(0, 12)} does not carry`,
      )
    }
  }
}

type SourceBlob = Readonly<{ kind: "blob" | "commit"; oid: string }>

/**
 * The declared source closure, read from a commit before setup can touch either
 * root. `--name-only` leaves Git to parse its own tree rows; this code only
 * carries the NUL-delimited repository paths into the existing blob reader.
 */
async function declaredSourceBlobs(
  run: ProgramRootCheck,
  commit: string,
  scripts: readonly string[],
): Promise<ReadonlyMap<string, SourceBlob>> {
  const blobs = new Map<string, SourceBlob>()
  for (const script of scripts) {
    const names = (await run.git(["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", commit, "--", script]))
      .split("\0")
      .filter((path) => path !== "")
    for (const path of names) {
      const oid = await refAt(run.git, `${commit}:${path}`, "blob")
      if (oid === undefined) throw new Error(`${commit.slice(0, 12)} lists declared source ${path} without an object`)
      const kind = (await run.git(["cat-file", "-t", `${commit}:${path}`])).trim()
      if (kind !== "blob" && kind !== "commit") {
        throw new Error(`${commit.slice(0, 12)} declared source ${path} is ${kind}, not a file or gitlink`)
      }
      const prior = blobs.get(path)
      if (prior !== undefined && (prior.kind !== kind || prior.oid !== oid)) {
        throw new Error(`${commit.slice(0, 12)} names declared source ${path} with conflicting objects`)
      }
      blobs.set(path, { kind, oid })
    }
  }
  return blobs
}

async function onDiskDeclaredPaths(
  run: ProgramRootCheck,
  root: string,
  scripts: readonly string[],
): Promise<ReadonlySet<string>> {
  if (scripts.length === 0) return new Set()
  const wt = gitIn(root, run.process, run.selection, run.gitOptions)
  return new Set(
    (await wt(["--literal-pathspecs", "ls-files", "-co", "--exclude-standard", "-z", "--", ...scripts]))
      .split("\0")
      .filter((path) => path !== ""),
  )
}

async function onDiskSourceBlob(
  run: ProgramRootCheck,
  root: string,
  path: string,
  expected: SourceBlob | undefined,
  symlink: boolean = false,
): Promise<string> {
  try {
    if (symlink) {
      return (
        await gitIn(
          root,
          run.process,
          run.selection,
          run.gitOptions,
        )(["hash-object", "--stdin"], readlinkSync(join(root, path)))
      ).trim()
    }
    if (expected?.kind === "commit") {
      return (await gitIn(join(root, path), run.process, run.selection, run.gitOptions)(["rev-parse", "HEAD"])).trim()
    }
    return (await gitIn(root, run.process, run.selection, run.gitOptions)(["hash-object", "--", path])).trim()
  } catch (error) {
    // A listed but unreadable source is a mismatch below, named in the log;
    // collapsing it into an absence would turn a damaged root into a pass.
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * A declared source must be checked on disk even when the candidate deleted it:
 * `ls-files --others --exclude-standard` deliberately omits ignored remnants,
 * which are still executable bytes if setup resurrected them.
 */
function declaredPathState(root: string, path: string): "present" | "absent" | "symlink" | string {
  try {
    const stat = lstatSync(join(root, path))
    if (stat.isSymbolicLink()) return "symlink"
    return "present"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function witnessDeclaredSources(
  run: ProgramRootCheck,
  spec: CheckSpec,
  phase: string,
  stage: "program" | "subject",
  root: string,
  expected: ReadonlyMap<string, SourceBlob>,
  baseline: ReadonlyMap<string, SourceBlob>,
): Promise<void> {
  const actual = await onDiskDeclaredPaths(run, root, spec.scripts ?? [])
  const paths = new Set([...expected.keys(), ...baseline.keys(), ...actual])
  const mismatched: string[] = []
  for (const path of [...paths].sort()) {
    const committed = expected.get(path)
    const state =
      committed === undefined && !baseline.has(path) && actual.has(path) ? "present" : declaredPathState(root, path)
    const ondisk =
      state === "present" || state === "symlink"
        ? await onDiskSourceBlob(run, root, path, committed, state === "symlink")
        : state
    const same = committed === undefined ? ondisk === "absent" : committed.oid === ondisk
    run.log.write({
      branch: run.branch,
      committed: committed?.oid ?? "deleted",
      head: run.head,
      kind: "judged",
      name: spec.name,
      ondisk,
      path,
      phase,
      root,
      same,
      stage: `program-${stage}-source`,
    })
    if (!same) mismatched.push(`${path} committed=${committed?.oid ?? "deleted"} ondisk=${ondisk}`)
  }
  if (mismatched.length > 0) {
    throw new Error(`program-root ${stage} source in ${root} differs from its recorded blobs: ${mismatched.join(", ")}`)
  }
}

async function witnessTree(
  run: ProgramRootCheck,
  spec: CheckSpec,
  phase: string,
  stage: "program" | "subject",
  root: string,
  expected: CheckedTree,
): Promise<void> {
  const actual = await checkedTree(root, run.targetSha, run.process, run.selection, run.gitOptions)
  const same = actual.candidate === expected.candidate && actual.base === expected.base
  run.log.write({
    base: actual.base,
    branch: run.branch,
    candidate: actual.candidate,
    expectedBase: expected.base,
    expectedCandidate: expected.candidate,
    head: run.head,
    kind: "judged",
    name: spec.name,
    phase,
    root,
    same,
    stage: `program-${stage}-tree`,
  })
  if (!same) {
    throw new Error(
      `program-root ${stage} ${root} moved during setup: expected ${expected.candidate.slice(0, 12)}/${expected.base.slice(0, 12)}, ` +
        `read ${actual.candidate.slice(0, 12)}/${actual.base.slice(0, 12)}`,
    )
  }
}

async function witnessChangedSubject(
  run: ProgramRootCheck,
  spec: CheckSpec,
  phase: string,
  root: string,
  tree: CheckedTree,
): Promise<void> {
  const files = await judgedTreeDigest(root, tree, run.process, run.selection, run.gitOptions)
  for (const file of files) {
    run.log.write({
      branch: run.branch,
      committed: file.committed,
      head: run.head,
      kind: "judged",
      name: spec.name,
      ondisk: file.ondisk,
      path: file.path,
      phase,
      root,
      same: file.same,
      stage: "program-subject-changed",
    })
  }
  const divergent = files.filter((file) => !file.same)
  if (divergent.length > 0) {
    throw new Error(
      `program-root subject ${root} differs from its recorded candidate blobs: ` +
        divergent.map((file) => `${file.path} committed=${file.committed} ondisk=${file.ondisk}`).join(", "),
    )
  }
}

async function prepareProgramRoot(
  run: ProgramRootCheck,
  commit: string,
  stage: "target" | "subject",
): Promise<PreparedWorktree> {
  const logDir = join(run.logDir, "program", `${stage}-${run.spec.name}`)
  const about = {
    branch: run.branch,
    head: run.head,
    name: `${SETUP}-program-${stage}-${run.spec.name}`,
    phase: run.phase,
  }
  return prepareWorktree(run.git, run.repo, commit, join(run.root, stage === "target" ? "P" : "C"), {
    env: run.env,
    process: run.process,
    selection: run.selection,
    gitOptions: run.gitOptions,
    populateReference: run.populateReference,
    plumbing: run.plumbing,
    targetSha: run.targetSha,
    ...(run.setup === undefined ? {} : { setup: { logDir, run: run.setup, tmpdir: run.tmpdir } }),
    starting: ({ log, start }) => recordProgramStart(run, { ...about, log, start }),
    record: ({ result, start, end }) => {
      const row = { ...about, start, end }
      if (run.phase === "base" || result.result === "pass") recordProgramResult(run, row, result)
      else recordProgramEnd(run, row, result)
    },
  })
}

export async function programRootCheck(run: ProgramRootCheck): Promise<CheckResult> {
  const { spec, tree, phase } = run
  await validateScripts(run, spec)
  const scripts = spec.scripts ?? []
  // Read both declarations before either setup runs. The comparison below is
  // against these immutable tree objects, never a post-setup Git index.
  const targetSources = await declaredSourceBlobs(run, run.targetSha, scripts)
  const subjectSources = await declaredSourceBlobs(run, tree.candidate, scripts)
  const targetTree: CheckedTree = { base: run.targetSha, candidate: run.targetSha }
  let program: PreparedWorktree | undefined
  let subject: PreparedWorktree | undefined
  try {
    program = await prepareProgramRoot(run, run.targetSha, "target")
    await witnessTree(run, spec, phase, "program", program.path, targetTree)
    await witnessDeclaredSources(run, spec, phase, "program", program.path, targetSources, targetSources)

    try {
      subject = await prepareProgramRoot(run, tree.candidate, "subject")
    } catch (error) {
      // C is another candidate worktree in submit/merge, so its setup needs
      // the same settled-ground reading as the phase worktree. Base has no
      // lower ground to read, and P is the target's own program root.
      if (!(error instanceof SetupFailed) || phase === "base") throw error
      throw new ProgramSubjectSetupFailed(error)
    }
    await witnessTree(run, spec, phase, "subject", subject.path, tree)
    await witnessDeclaredSources(run, spec, phase, "subject", subject.path, subjectSources, targetSources)
    await witnessChangedSubject(run, spec, phase, subject.path, tree)

    // `prepareWorktree` captures its tree before setup. Read both roots again
    // at the launch boundary, when an identity or source mutation still has a
    // retained log row and cannot become a child result by accident.
    await witnessTree(run, spec, phase, "program", program.path, targetTree)
    await witnessDeclaredSources(run, spec, phase, "program", program.path, targetSources, targetSources)
    await witnessTree(run, spec, phase, "subject", subject.path, tree)
    await witnessDeclaredSources(run, spec, phase, "subject", subject.path, subjectSources, targetSources)
    await witnessChangedSubject(run, spec, phase, subject.path, tree)

    const about = {
      branch: run.branch,
      head: run.head,
      name: spec.name,
      phase,
      ...(phase === "base" ? { scope: run.extraEnv === undefined ? ("full" as const) : ("narrowed" as const) } : {}),
      ...(spec.scripts === undefined || spec.scripts.length === 0 ? {} : { scripts: spec.scripts }),
    }
    const start = new Date().toISOString()
    recordProgramStart(run, { ...about, log: checkLogPath(run.logDir, spec.name), start })
    const result = await runCheck({
      cwd: subject.path,
      env: run.env,
      process: run.process,
      logDir: run.logDir,
      tmpdir: run.tmpdir,
      spec,
      tree,
      extraEnv: run.extraEnv,
      programRoot: program.path,
    })
    recordProgramResult(run, { ...about, end: new Date().toISOString(), start }, result)
    return result
  } finally {
    try {
      if (subject !== undefined) await subject.remove()
    } finally {
      if (program !== undefined) await program.remove()
    }
  }
}

/**
 * The row that says a program the queue runs has STARTED, written before it
 * runs: the same `check` kind, the same names, and the log file it is about to
 * write, read from the same place the driver will read it. A reader tells the
 * two rows apart by `end`, which only ending can say and which a start row
 * therefore does not carry (neither does it carry `ms`); the end row is
 * exactly what it always was, so nothing that reads one changes.
 *
 * Without this row a queue run's log is silent for the whole length of a
 * check, and a check that is merely long reads as a hung queue: R8 was stopped
 * as a hang while a 28.7-minute check ran (plan § Owed after M5).
 */
export function recordProgramStart(
  run: Readonly<{ log: Pick<QueueRunLog, "write"> }>,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    log: string
    /** Which base run this is, on a base-phase row: the whole check, or the scope it asked for. */
    scope?: "narrowed" | "full"
    scripts?: readonly string[]
  }>,
): void {
  run.log.write({ ...about, kind: "check" })
}

/**
 * The two records every program the queue runs writes, one shape for all of
 * them: what ran, then how it ended. Both at once for every caller that knows
 * how it ended AND whose it is by then, which is every caller but one — a
 * candidate's failing setup, whose verdict waits for the settled base.
 */
export function recordProgramResult(
  run: Readonly<{ log: Pick<QueueRunLog, "write"> }>,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    end: string
    /** Which base run this is, on a base-phase row: the whole check, or the scope it asked for. */
    scope?: "narrowed" | "full"
    scripts?: readonly string[]
  }>,
  result: CheckResult,
): void {
  recordProgramEnd(run, about, result)
  recordProgramVerdict(run, about, result)
}

/** The row that says a program the queue ran ENDED: how long it took, and the log it wrote. */
export function recordProgramEnd(
  run: Readonly<{ log: Pick<QueueRunLog, "write"> }>,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    end: string
    /** Which base run this is, on a base-phase row: the whole check, or the scope it asked for. */
    scope?: "narrowed" | "full"
    scripts?: readonly string[]
  }>,
  result: CheckResult,
): void {
  run.log.write({
    branch: about.branch,
    end: about.end,
    head: about.head,
    kind: "check",
    log: result.log,
    ms: result.durationMs,
    name: about.name,
    phase: about.phase,
    ...(about.scope === undefined ? {} : { scope: about.scope }),
    ...(about.scripts === undefined ? {} : { scripts: about.scripts }),
    start: about.start,
  })
}

/**
 * The row that says what a program the queue ran DECIDED, and whose that is.
 *
 * A stuck result is always the queue's, and so is a setup the queue could not
 * attribute; a failing check is the submitter's, which is the whole of the
 * rule. `whose` names an owner the caller has READ instead: a candidate setup
 * that failed where the settled base passed is the submitter's, and only the
 * base's own run can say so, which is why this row is separable from the end
 * row at all.
 */
export function recordProgramVerdict(
  run: Readonly<{ log: Pick<QueueRunLog, "write"> }>,
  about: Readonly<{ branch: string; head: string; name: string; phase: string }>,
  result: CheckResult,
  whose?: "queue" | "submitter",
): void {
  run.log.write({
    branch: about.branch,
    exit: String(result.exit),
    head: about.head,
    kind: "result",
    name: about.name,
    phase: about.phase,
    result: result.result,
    whose:
      result.result === "pass"
        ? undefined
        : (whose ?? (result.result === "stuck" || about.name === SETUP ? "queue" : "submitter")),
  })
}
