/**
 * @failure Task adapters can bypass canonical intake or lose durable task identity across replay.
 * @level l1
 * @consumer @yrd/task adapters and Yrd workflow plugins
 */
import { createMemoryEventStore, createYrd, pipe } from "@yrd/core"
import { describe, expect, it } from "vitest"
import { Task, withTasks, type HasTasks, type Task as TaskRecord, type TaskCommands, type TaskSource } from "@yrd/task"

function deterministicIds(): () => string {
  let next = 0
  return () => `id-${++next}`
}

function requireTasks<App extends HasTasks>(app: App): App {
  return app
}

describe("task intake", () => {
  it("composes a typed adapter boundary and durably records its canonical task", async () => {
    const ref = Task.ref("github", "beorn/yrd#42")
    const source: TaskSource = {
      id: "github",
      async resolve(requested) {
        expect(requested).toEqual(ref)
        return {
          ref: requested,
          title: "Keep task intake tracker-agnostic",
          description: "GitHub vocabulary stays inside this adapter.",
          url: "https://github.com/beorn/yrd/issues/42",
          labels: ["feature", "P1"],
          revision: "updated-at:2026-07-09T12:00:00Z",
        }
      },
    }
    const app = pipe(
      createYrd({
        store: createMemoryEventStore(),
        clock: () => "2026-07-09T12:00:00.000Z",
        idGen: deterministicIds(),
      }),
      withTasks({ sources: [source] }),
    )

    const record: TaskCommands["task"]["record"] = app.commands.task.record
    expect(record).toBe(app.commands.task.record)
    expect(requireTasks(app)).toBe(app)
    // @ts-expect-error Task capability has not been composed yet.
    requireTasks(createYrd({ store: createMemoryEventStore() }))

    const task = await app.tasks.intake(ref)

    expect(task).toEqual({
      ref,
      title: "Keep task intake tracker-agnostic",
      description: "GitHub vocabulary stays inside this adapter.",
      url: "https://github.com/beorn/yrd/issues/42",
      labels: ["feature", "P1"],
      revision: "updated-at:2026-07-09T12:00:00Z",
    })
    expect(await app.tasks.get(ref)).toEqual(task)
    expect((await app.state()).tasks.bySource.github?.["beorn/yrd#42"]).toEqual(task)
    expect(app.operation(app.commands.task.record, task)).toEqual({ op: "task.record", args: task })

    const events = await Array.fromAsync(app.events())
    expect(events).toEqual([
      {
        id: "id-2",
        name: "task/recorded",
        ts: "2026-07-09T12:00:00.000Z",
        cause: { commandId: "id-1", op: "task.record" },
        data: { task },
      },
    ])
  })

  it("supports direct tasks and records only changed source snapshots", async () => {
    const store = createMemoryEventStore()
    const ref = Task.ref("km", "@yrd/core/21012-monorepo")
    let current: TaskRecord = {
      ref,
      title: "Finish Yrd",
      description: "Build the final package graph.",
      revision: "node-rev-1",
    }
    const source: TaskSource = { id: "km", resolve: async () => current }
    const first = pipe(createYrd({ store, idGen: deterministicIds() }), withTasks({ sources: [source] }))

    await first.tasks.intake(ref)
    await first.tasks.intake(ref)
    current = { ...current, description: "Build and verify the final package graph.", revision: "node-rev-2" }
    await first.tasks.intake(ref)
    await first.tasks.record({ ref: Task.ref("local", "write-release-notes"), title: "Write release notes" })

    expect((await Array.fromAsync(first.events())).map((event) => event.name)).toEqual([
      "task/recorded",
      "task/recorded",
      "task/recorded",
    ])
    expect(await first.tasks.list()).toEqual([
      current,
      { ref: Task.ref("local", "write-release-notes"), title: "Write release notes" },
    ])

    const replayed = pipe(createYrd({ store }), withTasks())
    expect(await replayed.tasks.list()).toEqual(await first.tasks.list())
  })

  it("keeps source-native identifiers opaque even when they match object prototype keys", async () => {
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withTasks())
    const task: TaskRecord = {
      ref: Task.ref("__proto__", "constructor"),
      title: "An opaque external identifier",
    }

    await app.tasks.record(task)
    await app.tasks.record(task)

    expect(await app.tasks.get(task.ref)).toEqual(task)
    expect(await app.tasks.list()).toEqual([task])
    expect(await Array.fromAsync(app.events())).toHaveLength(1)
  })

  it("rejects unknown, missing, mismatched, duplicate, and malformed sources without recording", async () => {
    const missing: TaskSource = { id: "github", resolve: async () => undefined }
    const mismatched: TaskSource = {
      id: "km",
      resolve: async () => ({ ref: Task.ref("km", "different"), title: "Wrong task" }),
    }
    const app = pipe(createYrd({ store: createMemoryEventStore() }), withTasks({ sources: [missing, mismatched] }))

    await expect(app.tasks.intake(Task.ref("linear", "ENG-42"))).rejects.toThrow(
      "yrd: no task source 'linear' is registered",
    )
    await expect(app.tasks.intake(Task.ref("github", "beorn/yrd#404"))).rejects.toThrow(
      "yrd: task 'github:beorn/yrd#404' was not found",
    )
    await expect(app.tasks.intake(Task.ref("km", "expected"))).rejects.toThrow(
      "yrd: task source 'km' returned 'km:different' for 'km:expected'",
    )
    expect(() => app.tasks.register({ id: "github", resolve: async () => undefined })).toThrow(
      "yrd: task source 'github' is already registered",
    )
    await expect(app.tasks.record({ ref: { source: "local", id: "" }, title: "Malformed" })).rejects.toThrow(
      "yrd: task ref 'id' must not be empty",
    )

    expect(await app.tasks.list()).toEqual([])
    expect(await Array.fromAsync(app.events())).toEqual([])
  })
})
