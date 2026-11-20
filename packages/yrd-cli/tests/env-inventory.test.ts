/**
 * @failure Reading the environment format starts the queue's load-time identity probes.
 * @level l1 (the public data-reader import, with process creation observed)
 * @consumer host cleanup, worktree pool and post-close inventory readers
 * @testonly none
 */
import { expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import { createProcess } from "@yrd/process"

it("imports the public environment reader without starting a process", async () => {
  // Import in a fresh production runtime, so a previously loaded CLI or the test runner's module cache cannot
  // supply the result. Only process creation inside that data import is counted.
  await using process = createProcess({ cwd: fileURLToPath(new URL("..", import.meta.url)) })
  const result = await process.run({
    argv: [
      globalThis.process.execPath,
      "-e",
      `
      let starts = 0;
      const refuse = () => { starts++; throw new Error("unexpected process on data import"); };
      Bun.spawn = refuse;
      Bun.spawnSync = refuse;
      await import("@yrd/cli/environments");
      console.log(JSON.stringify({ starts }));
    `,
    ],
    timeoutMs: 10_000,
  })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ starts: 0 })
})
