// @failure an old Record ref is deleted without a retained historical event, or changes a live branch fold.
// @level l2
// @consumer the one-shot event queue adopter and its mixed-format readers
// @testonly none

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { openEvents } from "gitomic/events"
import { adoptLegacy, inspectLegacyAdoption } from "../src/migration.ts"
import { changeInput, changesRef, queueRef, readStatus, writeQueueEvent } from "../src/events.ts"
import { createEventStore, gitIn, selectionFor } from "../src/git.ts"
import { ABSENT, appendRecord, legacyStore } from "../src/legacy-records.ts"
import { changeRef } from "../src/refs.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

it("adopts an old head under a newer live chain, retains its records and deletes only under the same lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-adopter-round-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(work, "base.txt"), "base\n")
  await git(["add", "base.txt"])
  await git(["commit", "--quiet", "-m", "base"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:main"])
  await git(["checkout", "--quiet", "-b", "task/reused"])
  writeFileSync(join(work, "one.txt"), "one\n")
  await git(["add", "one.txt"])
  await git(["commit", "--quiet", "-m", "old head"])
  const oldHead = (await git(["rev-parse", "HEAD"])).trim()
  writeFileSync(join(work, "two.txt"), "two\n")
  await git(["add", "two.txt"])
  await git(["commit", "--quiet", "-m", "new head"])
  const newHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/reused"])

  const store = createEventStore(work, "origin", selectionFor(git))
  const created = await (
    await openEvents({ ...store, ref: queueRef("main"), writer: "yrd" })
  ).append(
    [
      {
        type: "created",
        props: [
          ["Commit", target],
          ["Time", "2026-09-24T10:00:00.000Z"],
        ],
        keeps: [target],
      },
    ],
    { expect: null },
  )
  const queueTip = created.head
  expect(queueTip).not.toBeNull()
  const live = await (
    await openEvents({ ...store, ref: changesRef("main", "task/reused"), writer: "@dev/2" })
  ).append(
    [
      changeInput("opened", {
        queueTip: queueTip as string,
        at: new Date("2026-09-24T10:05:00.000Z"),
        commit: newHead,
        by: "@dev/2",
      }),
    ],
    { expect: null },
  )
  const oldChange = { branch: "task/reused", head: oldHead }
  const oldRef = changeRef("main", oldChange)
  const oldRecord = await appendRecord(git, "main", {
    change: oldChange,
    kind: "opened",
    subject: "old submission",
    trailers: [
      ["Submitter", "@dev/2"],
      ["Issue", "24526"],
    ],
  })
  const legacy = await legacyStore(git)
  await legacy.backend.publish(legacy.repo, [{ ref: oldRef, expect: ABSENT, oid: oldRecord }], "origin")

  const plan = await inspectLegacyAdoption({ store, git, queue: "main", target })
  expect(
    plan.rows.map(({ branch, ref, record, oldStatus, plannedStatus, ending, targetChainTip }) => ({
      branch,
      ref,
      record,
      oldStatus,
      plannedStatus,
      ending,
      targetChainTip,
    })),
  ).toEqual([
    {
      branch: "task/reused",
      ref: oldRef,
      record: oldRecord,
      oldStatus: "cancelled",
      plannedStatus: "cancelled",
      ending: "cancelled",
      targetChainTip: live.head,
    },
  ])
  expect((await legacy.backend.listRefs(legacy.repo, oldRef, "origin")).get(oldRef)).toBe(oldRecord)
  await expect(adoptLegacy({ store, plan, at: new Date("2026-09-24T11:00:00.000Z") })).rejects.toThrow(
    /requires a paused event queue/,
  )
  await writeQueueEvent(store, "main", {
    type: "paused",
    by: "@chief",
    reason: "fenced adopter test",
    at: new Date("2026-09-24T10:30:00.000Z"),
  })
  const pausedPlan = await inspectLegacyAdoption({ store, git, queue: "main", target })
  const adopted = await adoptLegacy({ store, plan: pausedPlan, at: new Date("2026-09-24T11:00:00.000Z") })
  expect(adopted.map(({ result, branch, oldRef, oldOid }) => ({ result, branch, oldRef, oldOid }))).toEqual([
    { result: "adopted", branch: "task/reused", oldRef, oldOid: oldRecord },
  ])
  expect((await legacy.backend.listRefs(legacy.repo, oldRef, "origin")).has(oldRef)).toBe(false)
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/reused") })).events({ limit: 1024 })
  expect(events.map((event) => event.type)).toEqual(["opened", "adopted"])
  expect(events[1]?.links).toEqual(expect.arrayContaining([oldHead, oldRecord]))
  expect(events[1]?.props).toContainEqual(["Migrated-From", `${oldRef}@${oldRecord}`])
  expect(events[1]?.props).toContainEqual(["Adopted-Status", "cancelled"])
  expect(events[1]?.props).toContainEqual(["Adopted-Reason", "resubmitted"])
  expect(
    events[1]?.props.some(([key]) => ["Adopted-Verifying", "Adopted-Checking", "Adopted-Merging"].includes(key)),
  ).toBe(false)
  expect((await readStatus(store, "main", "task/reused")).commit).toBe(newHead)
  expect((await readStatus(store, "main", "task/reused")).status).toBe("queued")
  expect(events[0]?.id).toBe(live.events[0]?.id)

  // The same paused command also converts a branch with no event chain through
  // the old resting-state converter; no historical adopted ending is needed.
  await git(["checkout", "--quiet", "-b", "task/failed", target])
  writeFileSync(join(work, "failed.txt"), "failed\n")
  await git(["add", "failed.txt"])
  await git(["commit", "--quiet", "-m", "failed head"])
  const failedHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/failed"])
  const failedChange = { branch: "task/failed", head: failedHead }
  const failedRef = changeRef("main", failedChange)
  const failedOpened = await appendRecord(git, "main", {
    change: failedChange,
    kind: "opened",
    subject: "failed submission",
    trailers: [["Submitter", "@dev/2"]],
  })
  const failedEnding = await appendRecord(git, "main", {
    change: failedChange,
    kind: "failed",
    subject: "failed check",
    trailers: [["Reason", "check-failed"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: failedRef, expect: ABSENT, oid: failedEnding }], "origin")
  const failedPlan = await inspectLegacyAdoption({ store, git, queue: "main", target })
  expect(
    failedPlan.rows.map(({ branch, targetChainTip, plannedStatus, ending }) => ({
      branch,
      targetChainTip,
      plannedStatus,
      ending,
    })),
  ).toEqual([{ branch: "task/failed", targetChainTip: null, plannedStatus: "failed", ending: "failed" }])
  await adoptLegacy({ store, plan: failedPlan, at: new Date("2026-09-24T11:01:00.000Z") })
  expect((await legacy.backend.listRefs(legacy.repo, failedRef, "origin")).has(failedRef)).toBe(false)
  const failedEvents = await (
    await openEvents({ ...store, ref: changesRef("main", "task/failed") })
  ).events({ limit: 1024 })
  expect(failedEvents.map(({ type }) => type)).toEqual(["opened", "failed"])
  expect(failedEvents.flatMap(({ links }) => links)).toEqual(
    expect.arrayContaining([failedHead, failedOpened, failedEnding]),
  )
  expect((await readStatus(store, "main", "task/failed")).status).toBe("failed")

  // Sent repeats the merged result for notification, but adoption must use
  // the original merged record's time rather than the later sent time.
  await git(["checkout", "--quiet", "-b", "task/merged", target])
  writeFileSync(join(work, "merged.txt"), "merged\n")
  await git(["add", "merged.txt"])
  await git(["commit", "--quiet", "-m", "merged head"])
  const mergedHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/merged", "HEAD:main"])
  const mergedChange = { branch: "task/merged", head: mergedHead }
  const mergedRef = changeRef("main", mergedChange)
  await appendRecord(git, "main", {
    change: mergedChange,
    kind: "opened",
    subject: "merged submission",
    trailers: [["Submitter", "@dev/2"]],
  })
  const atMerged = gitIn(work, undefined, undefined, {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-24T11:10:00Z", GIT_COMMITTER_DATE: "2026-09-24T11:10:00Z" },
  })
  const mergedRecord = await appendRecord(atMerged, "main", {
    change: mergedChange,
    kind: "merged",
    subject: "merged into main",
    trailers: [["Merge", mergedHead]],
  })
  const atSent = gitIn(work, undefined, undefined, {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-24T11:20:00Z", GIT_COMMITTER_DATE: "2026-09-24T11:20:00Z" },
  })
  const sentRecord = await appendRecord(atSent, "main", {
    change: mergedChange,
    kind: "sent",
    subject: "merge notice sent",
    trailers: [
      ["State", "merged"],
      ["To", "@dev/2"],
      ["Delivery", "sent"],
    ],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: mergedRef, expect: ABSENT, oid: sentRecord }], "origin")
  const mergedPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: mergedHead })
  expect(mergedPlan.rows.map(({ branch, ending }) => ({ branch, ending }))).toEqual([
    { branch: "task/merged", ending: "merged" },
  ])
  await adoptLegacy({ store, plan: mergedPlan, at: new Date("2026-09-24T11:30:00.000Z") })
  const mergedEvents = await (
    await openEvents({ ...store, ref: changesRef("main", "task/merged") })
  ).events({ limit: 1024 })
  expect(mergedEvents.map(({ type }) => type)).toEqual(["opened", "merged"])
  expect(mergedEvents[1]?.props).toContainEqual(["Time", "2026-09-24T11:10:00.000Z"])
  expect(mergedEvents.flatMap(({ links }) => links)).toEqual(expect.arrayContaining([mergedRecord, sentRecord]))

  // A competing old Record write between inspection and MULTI publication
  // refuses the one row and leaves no partial event chain behind.
  await git(["checkout", "--quiet", "-b", "task/race", mergedHead])
  writeFileSync(join(work, "race.txt"), "race\n")
  await git(["add", "race.txt"])
  await git(["commit", "--quiet", "-m", "race head"])
  const raceHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/race"])
  const raceChange = { branch: "task/race", head: raceHead }
  const raceRef = changeRef("main", raceChange)
  const raceRecord = await appendRecord(git, "main", {
    change: raceChange,
    kind: "opened",
    subject: "race submission",
    trailers: [["Submitter", "@dev/2"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: raceRef, expect: ABSENT, oid: raceRecord }], "origin")
  await git(["checkout", "--quiet", "-b", "task/zz-after", mergedHead])
  writeFileSync(join(work, "after.txt"), "after\n")
  await git(["add", "after.txt"])
  await git(["commit", "--quiet", "-m", "after head"])
  const afterHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/zz-after"])
  const afterChange = { branch: "task/zz-after", head: afterHead }
  const afterRef = changeRef("main", afterChange)
  const afterRecord = await appendRecord(git, "main", {
    change: afterChange,
    kind: "opened",
    subject: "after submission",
    trailers: [["Submitter", "@dev/2"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: afterRef, expect: ABSENT, oid: afterRecord }], "origin")
  const racePlan = await inspectLegacyAdoption({ store, git, queue: "main", target: mergedHead })
  const rivalRecord = await appendRecord(git, "main", {
    change: raceChange,
    kind: "checked",
    subject: "rival checked it",
    trailers: [],
  })
  const publish = store.backend.publish
  if (publish === undefined) throw new Error("fixture Gitomic backend has no publish")
  let raced = false
  const racedStore = {
    ...store,
    backend: {
      ...store.backend,
      publish: async (...args: Parameters<typeof publish>) => {
        if (!raced && args[1].some(({ ref }) => ref === raceRef)) {
          raced = true
          await publish(legacy.repo, [{ ref: raceRef, expect: raceRecord, oid: rivalRecord }], "origin")
        }
        return publish(...args)
      },
    },
  }
  const refused = await adoptLegacy({ store: racedStore, plan: racePlan, at: new Date("2026-09-24T11:40:00.000Z") })
  expect(refused).toEqual([
    {
      result: "refused",
      branch: "task/race",
      oldRef: raceRef,
      oldOid: raceRecord,
      ref: raceRef,
      expected: raceRecord,
      observed: rivalRecord,
      branchFact: expect.stringContaining("refs/heads/task/race at"),
    },
    {
      result: "adopted",
      branch: "task/zz-after",
      oldRef: afterRef,
      oldOid: afterRecord,
      eventOid: expect.any(String),
      branchFact: expect.stringContaining("refs/heads/task/zz-after at"),
    },
  ])
  expect((await legacy.backend.listRefs(legacy.repo, raceRef, "origin")).get(raceRef)).toBe(rivalRecord)
  await expect((await openEvents({ ...store, ref: changesRef("main", "task/race") })).head()).resolves.toBeNull()
  expect((await legacy.backend.listRefs(legacy.repo, afterRef, "origin")).has(afterRef)).toBe(false)
  const current = await inspectLegacyAdoption({ store, git, queue: "main", target: mergedHead })
  expect(current.rows[0]?.record).toBe(rivalRecord)

  // The planner is a public reader: a fresh repository may know the remote
  // target ref without having its commit object yet.
  await git(["checkout", "--quiet", "main"])
  await git(["merge", "--quiet", "--ff-only", mergedHead])
  writeFileSync(join(work, "target-after.txt"), "target after\n")
  await git(["add", "target-after.txt"])
  await git(["commit", "--quiet", "-m", "target after"])
  const nextTarget = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:main"])
  const reader = join(root, "reader")
  await seed(["init", "--quiet", "--initial-branch=main", reader])
  const readerGit = gitIn(reader)
  await readerGit(["remote", "add", "origin", remote])
  await expect(readerGit(["cat-file", "-e", `${nextTarget}^{commit}`])).rejects.toThrow()
  const readerStore = createEventStore(reader, "origin", selectionFor(readerGit))
  const freshPlan = await inspectLegacyAdoption({
    store: readerStore,
    git: readerGit,
    queue: "main",
    target: nextTarget,
  })
  expect(freshPlan.rows.map(({ ref }) => ref)).toEqual([raceRef])

  await git(["checkout", "--quiet", "task/race"])
  writeFileSync(join(work, "race-new.txt"), "race new\n")
  await git(["add", "race-new.txt"])
  await git(["commit", "--quiet", "-m", "race new head"])
  const raceNewHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/race"])
  const liveRace = await (
    await openEvents({ ...store, ref: changesRef("main", "task/race"), writer: "@dev/2" })
  ).append(
    [
      changeInput("opened", {
        queueTip: pausedPlan.queueTip,
        at: new Date("2026-09-24T11:50:00.000Z"),
        commit: raceNewHead,
        by: "@dev/2",
      }),
    ],
    { expect: null },
  )
  const movedPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  let movedEvent: string | undefined
  const movedStore = {
    ...store,
    backend: {
      ...store.backend,
      publish: async (...args: Parameters<typeof publish>) => {
        if (movedEvent === undefined && args[1].some(({ ref }) => ref === raceRef)) {
          const rival = await (
            await openEvents({ ...store, ref: changesRef("main", "task/race"), writer: "@chief" })
          ).append(
            [
              changeInput("ignored", {
                queueTip: pausedPlan.queueTip,
                at: new Date("2026-09-24T11:51:00.000Z"),
                by: "@chief",
                reason: "concurrent test writer",
              }),
            ],
            { expect: liveRace.head },
          )
          movedEvent = rival.head ?? undefined
        }
        return publish(...args)
      },
    },
  }
  const moved = await adoptLegacy({ store: movedStore, plan: movedPlan, at: new Date("2026-09-24T11:52:00.000Z") })
  expect(moved).toEqual([
    {
      result: "refused",
      branch: "task/race",
      oldRef: raceRef,
      oldOid: rivalRecord,
      ref: changesRef("main", "task/race"),
      expected: liveRace.head,
      observed: movedEvent,
      branchFact: expect.stringContaining("refs/heads/task/race at"),
    },
  ])
  expect((await legacy.backend.listRefs(legacy.repo, raceRef, "origin")).get(raceRef)).toBe(rivalRecord)

  // @failure a moved branch makes the old opened head's resting status stale before publication.
  const branchPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  writeFileSync(join(work, "race-later.txt"), "later\n")
  await git(["add", "race-later.txt"])
  await git(["commit", "--quiet", "-m", "later branch head"])
  const laterHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/race"])
  const branchRefused = await adoptLegacy({ store, plan: branchPlan, at: new Date("2026-09-24T11:53:00.000Z") })
  expect(branchRefused).toEqual([
    {
      result: "refused",
      branch: "task/race",
      oldRef: raceRef,
      oldOid: rivalRecord,
      ref: "refs/heads/task/race",
      expected: raceNewHead,
      observed: laterHead,
      branchFact: `refs/heads/task/race at ${laterHead}, leased`,
    },
  ])
  expect((await legacy.backend.listRefs(legacy.repo, raceRef, "origin")).get(raceRef)).toBe(rivalRecord)

  // @failure an old branch beneath changes/ is hidden by the new event-chain prefix.
  await git(["checkout", "--quiet", "-b", "changes/straggler", nextTarget])
  writeFileSync(join(work, "straggler.txt"), "straggler\n")
  await git(["add", "straggler.txt"])
  await git(["commit", "--quiet", "-m", "straggler head"])
  const stragglerHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:changes/straggler"])
  const stragglerChange = { branch: "changes/straggler", head: stragglerHead }
  const stragglerRef = changeRef("main", stragglerChange)
  const stragglerRecord = await appendRecord(git, "main", {
    change: stragglerChange,
    kind: "opened",
    subject: "old straggler",
    trailers: [["Submitter", "@dev/2"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: stragglerRef, expect: ABSENT, oid: stragglerRecord }], "origin")
  const namespacePlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  const namespaceRow = namespacePlan.rows.find(({ ref }) => ref === stragglerRef)
  expect(namespaceRow).toBeDefined()
  if (namespaceRow === undefined) throw new Error("fixture old branch was not planned")
  await adoptLegacy({
    store,
    plan: { ...namespacePlan, rows: [namespaceRow] },
    at: new Date("2026-09-24T11:54:00.000Z"),
  })
  expect((await legacy.backend.listRefs(legacy.repo, stragglerRef, "origin")).has(stragglerRef)).toBe(false)
  expect(await (await openEvents({ ...store, ref: changesRef("main", "changes/straggler") })).head()).not.toBeNull()

  // @failure a deleted branch suppresses a readable old Record or silently fabricates a lease.
  await git(["checkout", "--quiet", "-b", "task/absent", nextTarget])
  writeFileSync(join(work, "absent.txt"), "absent\n")
  await git(["add", "absent.txt"])
  await git(["commit", "--quiet", "-m", "absent head"])
  const absentHead = (await git(["rev-parse", "HEAD"])).trim()
  const absentChange = { branch: "task/absent", head: absentHead }
  const absentRef = changeRef("main", absentChange)
  const absentRecord = await appendRecord(git, "main", {
    change: absentChange,
    kind: "opened",
    subject: "old submission without a remote branch",
    trailers: [["Submitter", "@dev/2"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: absentRef, expect: ABSENT, oid: absentRecord }], "origin")
  const absentPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  const absentRow = absentPlan.rows.find(({ ref }) => ref === absentRef)
  expect(absentRow).toMatchObject({ branchHead: null, oldStatus: "cancelled", plannedStatus: "cancelled" })
  if (absentRow === undefined) throw new Error("fixture absent branch was not planned")
  expect(absentRow.branchObservedAt).toBeInstanceOf(Date)
  const absentReceipt = await adoptLegacy({
    store,
    plan: { ...absentPlan, rows: [absentRow] },
    at: new Date("2026-09-24T11:55:00.000Z"),
  })
  expect(absentReceipt).toEqual([
    expect.objectContaining({
      result: "adopted",
      branchFact: expect.stringMatching(/^refs\/heads\/task\/absent absent at .+, not leasable$/),
    }),
  ])
  const absentEvents = await (
    await openEvents({ ...store, ref: changesRef("main", "task/absent") })
  ).events({ limit: 1024 })
  expect(absentEvents.map(({ type }) => type)).toEqual(["opened", "cancelled"])
  expect(
    absentEvents.every(({ props }) =>
      props.some(([key, value]) => key === "Branch" && value === absentReceipt[0]?.branchFact),
    ),
  ).toBe(true)

  // @failure a branch absent at inspection reappears before apply, but the old absent reading is published.
  await git(["checkout", "--quiet", "-b", "task/reappears", nextTarget])
  writeFileSync(join(work, "reappears.txt"), "reappears\n")
  await git(["add", "reappears.txt"])
  await git(["commit", "--quiet", "-m", "reappearing head"])
  const reappearingHead = (await git(["rev-parse", "HEAD"])).trim()
  const reappearingChange = { branch: "task/reappears", head: reappearingHead }
  const reappearingRef = changeRef("main", reappearingChange)
  const reappearingRecord = await appendRecord(git, "main", {
    change: reappearingChange,
    kind: "opened",
    subject: "old submission before branch appears",
    trailers: [["Submitter", "@dev/2"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: reappearingRef, expect: ABSENT, oid: reappearingRecord }], "origin")
  const reappearingPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  const reappearingRow = reappearingPlan.rows.find(({ ref }) => ref === reappearingRef)
  expect(reappearingRow?.branchHead).toBeNull()
  if (reappearingRow === undefined) throw new Error("fixture reappearing branch was not planned")
  await git(["push", "--quiet", "origin", "HEAD:task/reappears"])
  const reappearingReceipt = await adoptLegacy({
    store,
    plan: { ...reappearingPlan, rows: [reappearingRow] },
    at: new Date("2026-09-24T11:56:00.000Z"),
  })
  expect(reappearingReceipt).toEqual([
    expect.objectContaining({
      result: "adopted",
      branchFact: `refs/heads/task/reappears at ${reappearingHead}, leased`,
    }),
  ])
  expect((await readStatus(store, "main", "task/reappears")).status).toBe("queued")
  const reappearingEvents = await (
    await openEvents({ ...store, ref: changesRef("main", "task/reappears") })
  ).events({ limit: 1024 })
  expect(reappearingEvents.map(({ type }) => type)).toEqual(["opened"])
  expect(reappearingEvents[0]?.props).toContainEqual(["Branch", reappearingReceipt[0]?.branchFact])

  // @failure a transient remote branch read stops the whole one-shot apply before another row is adopted.
  await git(["checkout", "--quiet", "-b", "task/after-read-error", nextTarget])
  writeFileSync(join(work, "after-read-error.txt"), "after read error\n")
  await git(["add", "after-read-error.txt"])
  await git(["commit", "--quiet", "-m", "after read error head"])
  const afterReadHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/after-read-error"])
  const afterReadChange = { branch: "task/after-read-error", head: afterReadHead }
  const afterReadRef = changeRef("main", afterReadChange)
  const afterReadRecord = await appendRecord(git, "main", {
    change: afterReadChange,
    kind: "opened",
    subject: "old submission after a failed read",
    trailers: [["Submitter", "@dev/2"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: afterReadRef, expect: ABSENT, oid: afterReadRecord }], "origin")
  const readErrorPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  const readErrorRows = readErrorPlan.rows.filter(({ ref }) => ref === raceRef || ref === afterReadRef)
  expect(readErrorRows).toHaveLength(2)
  const listRefs = store.backend.listRefs
  if (listRefs === undefined) throw new Error("fixture Gitomic backend has no listRefs")
  const readErrorStore = {
    ...store,
    backend: {
      ...store.backend,
      listRefs: async (...args: Parameters<typeof listRefs>) => {
        if (args[1] === "refs/heads/task/race") throw new Error("injected branch read error")
        return listRefs(...args)
      },
    },
  }
  const readErrorReceipts = await adoptLegacy({
    store: readErrorStore,
    plan: { ...readErrorPlan, rows: readErrorRows },
    at: new Date("2026-09-24T11:57:00.000Z"),
  })
  expect(readErrorReceipts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        result: "refused",
        oldRef: raceRef,
        ref: "refs/heads/task/race",
        error: expect.stringContaining("injected branch read error"),
        branchFact: expect.stringContaining("refs/heads/task/race at"),
      }),
      expect.objectContaining({
        result: "adopted",
        oldRef: afterReadRef,
        branchFact: `refs/heads/task/after-read-error at ${afterReadHead}, leased`,
      }),
    ]),
  )
  expect((await legacy.backend.listRefs(legacy.repo, raceRef, "origin")).has(raceRef)).toBe(true)
  expect((await legacy.backend.listRefs(legacy.repo, afterReadRef, "origin")).has(afterReadRef)).toBe(false)

  // @failure an absent branch reappears at an on-target head and turns a recorded failure into an unevidenced merge.
  const reclassChange = { branch: "task/reclass", head: mergedHead }
  const reclassRef = changeRef("main", reclassChange)
  await appendRecord(git, "main", {
    change: reclassChange,
    kind: "opened",
    subject: "old submission later classified",
    trailers: [["Submitter", "@dev/2"]],
  })
  const reclassRecord = await appendRecord(git, "main", {
    change: reclassChange,
    kind: "failed",
    subject: "recorded failure without merge evidence",
    trailers: [["Reason", "check-failed"]],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: reclassRef, expect: ABSENT, oid: reclassRecord }], "origin")
  const reclassPlan = await inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })
  const reclassRow = reclassPlan.rows.find(({ ref }) => ref === reclassRef)
  expect(reclassRow).toMatchObject({ branchHead: null, oldStatus: "cancelled" })
  if (reclassRow === undefined) throw new Error("fixture reclassified branch was not planned")
  await git(["push", "--quiet", "origin", `${mergedHead}:refs/heads/task/reclass`])
  const reclassReceipt = await adoptLegacy({
    store,
    plan: { ...reclassPlan, rows: [reclassRow] },
    at: new Date("2026-09-24T11:58:00.000Z"),
  })
  expect(reclassReceipt).toEqual([
    expect.objectContaining({
      result: "refused",
      ref: "refs/heads/task/reclass",
      branchFact: `refs/heads/task/reclass at ${mergedHead}, leased`,
      error: expect.stringContaining("merged adoption needs the original Merge: evidence"),
    }),
  ])
  expect((await legacy.backend.listRefs(legacy.repo, reclassRef, "origin")).get(reclassRef)).toBe(reclassRecord)
  await expect((await openEvents({ ...store, ref: changesRef("main", "task/reclass") })).head()).resolves.toBeNull()

  // @failure a missing original Merge: gets replaced with the old head and deletes the only source.
  await git(["checkout", "--quiet", "-b", "task/merge-without-evidence", nextTarget])
  writeFileSync(join(work, "unproven.txt"), "unproven\n")
  await git(["add", "unproven.txt"])
  await git(["commit", "--quiet", "-m", "unproven head"])
  const unprovenHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", "HEAD:task/merge-without-evidence"])
  const unprovenChange = { branch: "task/merge-without-evidence", head: unprovenHead }
  const unprovenRef = changeRef("main", unprovenChange)
  await appendRecord(git, "main", {
    change: unprovenChange,
    kind: "opened",
    subject: "opened before unproven merge",
    trailers: [["Submitter", "@dev/2"]],
  })
  const unprovenRecord = await appendRecord(git, "main", {
    change: unprovenChange,
    kind: "merged",
    subject: "merged without Merge trailer",
    trailers: [],
  })
  await legacy.backend.publish(legacy.repo, [{ ref: unprovenRef, expect: ABSENT, oid: unprovenRecord }], "origin")
  await expect(inspectLegacyAdoption({ store, git, queue: "main", target: nextTarget })).rejects.toThrow(
    /merged adoption needs the original Merge: evidence/,
  )
  expect((await legacy.backend.listRefs(legacy.repo, unprovenRef, "origin")).get(unprovenRef)).toBe(unprovenRecord)
})
