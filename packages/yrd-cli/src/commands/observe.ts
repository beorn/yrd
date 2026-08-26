import { changeDeliveryState, currentChangeRev } from "@yrd/bay"
import {
  mergeJoinedNothing,
  mergeRecordToStatement,
  Queues,
  type InTotoStatement,
  type MergeRecordBody,
} from "@yrd/queue"
import { configuration } from "../invocation.ts"
import { printResult } from "../output.tsx"
import { resolveCanonicalRunSelector } from "../qualified-run-ref.ts"
import { configDoctor, dashboard, jsonEnabled, mergeInstant, mergeRepair, stateOf, type JsonOption } from "../run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices } from "../types.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the observation surface: the default dashboard, `doctor`, and `why`. */
export function registerObserveCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, installedServices, io, setExit } = ctx
  program
    .command("_dashboard", { isDefault: true, hidden: true })
    .option("--base <branch>", "scope the dashboard to one base")
    .option("--json", "emit stable JSON")
    .action(async (options) => dashboard(installed(), options, io))
  program
    .command("doctor")
    .description("diagnose repository configuration and retention warnings")
    .option("--rebuild-views", "atomically rebuild registered query views from immutable Journal history")
    .option(
      "--rebuild-index-from-repo",
      "rebuild missing pr/integrated index rows for PRs the journal already knows, from every proven " +
        "merge record in the repository (cannot recreate a change entity the journal has never seen)",
    )
    .option(
      "--retract-unprovable",
      "list EVERY merge record the repository cannot prove, by cause; add --apply to append a retraction " +
        "beside each one so the estate verifies again (records are never edited — a retraction is a new " +
        "note on its own ref, and the original stays byte-identical)",
    )
    .option("--apply", "with --retract-unprovable, actually append the retractions instead of listing them")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await configDoctor(installed(), installedServices(), options, io)))
  program
    .command("why <selector>")
    .description("prove one change merge from repository truth and its journal index")
    .option("--repair", "append a missing pr/integrated index row from repository proof")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(
        await explainMerge(
          installed(),
          installedServices(),
          // `yrd why` accepts the canonical `path@branch#N` run address and
          // the bare `#N` form (items 34/36); the resolver validates the
          // path half against this repository before stripping it.
          resolveCanonicalRunSelector(selector, io.repositoryRoot),
          options,
          io,
        ),
      ),
    )
}

/**
 * The in-toto Statement projection over a durable merge record, for `--json`
 * consumers that want the merge in attestation shape.
 *
 * `builderId` is the queue that produced the merge. It is deliberately not a
 * `MergeRecordBody` field — the record is checksummed and the projection is free
 * to change — so it comes from the journal's own run. Both ways the projection
 * can be absent are named rather than dropped from the payload: a refused or
 * canceled attempt minted no merged commit to be the Statement's subject, and a
 * record whose run the journal has never seen has no builder to attribute.
 */
function mergeStatement(
  app: YrdCliApp,
  record: MergeRecordBody,
): Readonly<{ statement: InTotoStatement }> | Readonly<{ statementUnavailable: string }> {
  const run = Queues.resolve(stateOf(app).queues, record.merge.id)
  if (run === undefined) {
    return {
      statementUnavailable: `run '${record.merge.id}' is not in the journal, so the attesting queue is unknown`,
    }
  }
  const statement = mergeRecordToStatement(record, run.queueId)
  return statement === undefined
    ? {
        statementUnavailable: `merge '${record.merge.id}' is ${record.merge.result}, so it minted no merged commit to attest`,
      }
    : { statement }
}

async function explainMerge(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption & Readonly<{ repair?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (services.mergeRecords !== undefined) {
    const proof = await services.mergeRecords.find(selector)
    if (proof.status === "repository-corrupt" || proof.status === "repository-incomplete") {
      // The refusal is correct — a single answer must not come from a partially
      // verified estate — but it was indistinguishable from "your merge is
      // broken", and for two days it was the SAME text for every selector. So say
      // the one thing that separates those: whether THIS selector's own record
      // verified, and how many records the estate could not prove.
      const isolated = await services.mergeRecords.all()
      const own =
        isolated.status === "proven"
          ? isolated.records.some((entry) =>
              entry.record.changes.some((change) => change.pr === selector || entry.record.merge.id === selector),
            )
          : undefined
      const unprovable = isolated.status === "proven" ? isolated.unverifiable.length : undefined
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "why",
          selector,
          verdict: proof.status,
          reason: proof.reason,
          repaired: false,
          ...(own === undefined ? {} : { selectorRecordVerified: own }),
          ...(unprovable === undefined ? {} : { unprovableRecords: unprovable }),
        },
        [
          `${proof.status.toUpperCase()} — ${selector}: ${proof.reason}`,
          own === undefined
            ? "  the estate could not be enumerated, so this selector's own record is unknown"
            : own
              ? `  this selector's OWN record verified — the refusal is the estate's, not this merge's`
              : `  this selector's own record did not verify either`,
          unprovable === undefined
            ? ""
            : `  ${String(unprovable)} record(s) in the estate cannot prove themselves; ` +
              "a single answer is not given from a partially verified estate — " +
              "run `yrd doctor --retract-unprovable` to see them by cause",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      )
      return 2
    }
    if (proof.status === "proven") {
      const attempts = [...proof.records].sort((left, right) => mergeInstant(left.record) - mergeInstant(right.record))
      const latest = attempts.at(-1)
      if (latest === undefined) configuration("repository merge-record query returned no proven records")
      const verdict = latest.record.merge.result
      const reason = latest.record.reason
      const fix = latest.record.fix
      let repaired = false
      const pr = app.bays.pr(selector)
      if (verdict === "merged" && options.repair === true && pr !== undefined) {
        const repair = mergeRepair(latest.record, pr)
        if (repair.status === "repairable") {
          await app.queue.reconcileMerge(repair.input)
          repaired = true
        }
      }
      // Nothing-new is a first-class outcome, not a defect: the change was already
      // contained, so "at <commit>" would print the BASE and read as a fresh merge.
      // Derived here by predicate — the record stores the facts, never the label.
      const nothingNew = mergeJoinedNothing(latest.record)
      const human =
        verdict === "merged"
          ? nothingNew
            ? `MERGED — ${selector} via ${latest.record.merge.id}: already up to date — ` +
              `joined nothing new to '${latest.record.merge.base}' at ${latest.record.merge.baseSha}`
            : `MERGED — ${selector} via ${latest.record.merge.id} at ${latest.record.merge.mergedCommit}`
          : `${verdict.toUpperCase()} — ${latest.record.merge.id}: ${reason?.code ?? "unknown"}: ${reason?.message ?? "no reason recorded"}${fix === undefined ? "" : ` — fix: ${fix}`}`
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "why",
          selector,
          verdict,
          ...(nothingNew ? { nothingNew } : {}),
          repaired,
          record: latest.record,
          pointer: latest.pointer,
          attempts,
          ...mergeStatement(app, latest.record),
        },
        human,
      )
      return verdict === "merged" ? 0 : 1
    }
  }
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "why", selector, verdict: "not-proven", reason: "merge-record-missing", repaired: false },
      `NOT-PROVEN — ${selector}: merge-record-missing`,
    )
    return 1
  }
  const revision = currentChangeRev(pr)
  if (revision.changeId === undefined) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "why", pr: pr.id, verdict: "legacy-unprovable", repaired: false },
      `LEGACY-UNPROVABLE — ${pr.id} predates stable Change-Id identity`,
    )
    return 1
  }
  const indexed = changeDeliveryState(pr) === "integrated"
  const verdict = indexed ? "index-corrupt" : "not-proven"
  await printResult(
    io,
    jsonEnabled(options),
    { command: "why", selector, verdict, reason: "merge-record-missing", repaired: false },
    `${verdict.toUpperCase()} — ${pr.id}: merge-record-missing`,
  )
  return indexed ? 2 : 1
}
