/**
 * @reach fs-walk vendor/yrd/packages/*\/src/** vendor/yrd/packages/*\/scripts/**
 */
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REF_COMMAND = /\[\s*"(ls-remote|for-each-ref|update-ref|fetch|push)"/gu

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")
}

function refCommands(text: string): string[] {
  return [...text.matchAll(REF_COMMAND)].map((match) => match[1] ?? "")
}

describe("the Yrd Gitomic boundary", () => {
  it("retires every production Record reader (25041)", () => {
    // @source-grep: a future legacy fallback can compile and pass event journeys;
    // the accepted retirement contract permits no ongoing Record reader.
    const repo = new URL("../../../", import.meta.url)
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages"], {
      cwd: fileURLToPath(repo),
      encoding: "utf8",
    }).split("\0")
    const hits = tracked
      .filter(
        (path) =>
          /^packages\/[^/]+\/(?:src|scripts)\/.*\.[cm]?[jt]sx?$/u.test(path) && !/\.test\.[cm]?[jt]sx?$/u.test(path),
      )
      // The trailer key, not an identifier ending in it (`onRecord:`); `\n` is the key inside a regex literal.
      .map((path) => ({
        path,
        count: readFileSync(new URL(path, repo), "utf8").match(/(?:^|[^\w$]|\\n)Record:/gmu)?.length ?? 0,
      }))
      .filter(({ count }) => count > 0)
    expect(hits).toEqual([])
  })

  it("routes every production event-chain read through the named Yrd read policy", () => {
    // @source-grep: the P0 direct notice read fell back to Gitomic's default 50;
    // the policy is the only production site allowed to call these raw readers.
    const sites = readdirSync(new URL("../src/", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) => [...source(name).matchAll(/(?:\.events|\bchainsUnder)\s*\(/gu)].map(() => name))
    expect(sites.length).toBeGreaterThan(0)
    expect(sites.filter((name) => name !== "event-read.ts")).toEqual([])
  })

  it("owns every queue ref read and write", () => {
    // Source-text checks are invisible to import-based test selection. Enumerate
    // every ref-command site so a new site requires an explicit boundary review.
    const sites = Object.fromEntries(
      readdirSync(new URL("../src/", import.meta.url))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => [name, refCommands(source(name))] as const)
        .filter(([, commands]) => commands.length > 0),
    )
    expect(sites).toEqual({
      // The candidate-refs backlog sweep and terminal-state deletion (26022):
      // scans and prunes candidate mirror refs (refs/heads/yrd/candidates/* and refs/yrd/candidates/*),
      // which are not queue refs and use --force-with-lease CAS deletions.
      "candidate-refs.ts": ["ls-remote", "push", "push", "ls-remote", "push", "push"],
      // Local check cleanup (27514, 27540) owns only refs/yrd-check/* and
      // refs/heads/yrd-check/*, with expected-SHA deletion. The native sweep
      // control preserves ordinary and queue-change refs; queue event-chain
      // reads and writes remain inside the Gitomic boundary.
      "check-refs.ts": ["for-each-ref", "update-ref", "for-each-ref"],
      // The host mirror's own `fetch --prune` (25570 row 1): it refreshes a store of hosted repositories and reads
      // or writes no queue ref.
      "mirror.ts": ["fetch"],
      // The gitlink carrier (fae9be0590, 25823): an object-only fetch of the component pin it carries, proving the queue
      // can fetch it, and a read of the local refs/heads/<branch> it would create. Neither reads or writes a queue ref.
      "pin-carrier.ts": ["fetch", "for-each-ref"],
      // Preview custody (27510, @cto eb147b05, a130eadf): refs/yrd/preview/<clone>/<subject>/<candidate-root> in the
      // AUTHOR's own root and component stores, never a queue ref. Every delete is at its expected OID: the superseded
      // prior root, a failed attempt's own anchors (root, components), a retired root, a retired subject's root and an
      // orphaned component anchor; then the one listing of a prefix.
      "preview-custody.ts": [
        "update-ref",
        "update-ref",
        "update-ref",
        "update-ref",
        "update-ref",
        "update-ref",
        "for-each-ref",
      ],
      "publication.ts": ["push"],
      // The reference store owner: (27176, first) the derive step's fresh read of a component's main into the store's
      // refs/remotes/origin/main — a component ref, not a queue ref, read where its store lives rather than from
      // derive.ts — then the pin ref it keeps, the object-only fetch of a pin, preview custody's create-only anchor
      // (`createRef`, 27510: `update-ref --stdin create`, so an existing anchor is never moved), and the
      // remote-answers probe.
      "reference.ts": ["fetch", "update-ref", "fetch", "update-ref", "ls-remote"],
      "settled-base.ts": ["fetch"],
      // Submit's two object-only fetches: collect an absent component pin (27091)
      // and model moved gitlinks during compose verification (26754).
      // Retention writes go through the sanctioned Git-super executor below.
      "submit.ts": ["fetch", "fetch"],
    })

    for (const name of ["git.ts", "pause.ts", "remote.ts", "withdraw.ts"]) {
      expect(refCommands(source(name)), name).toEqual([])
    }

    const submit = source("submit.ts")
    const [gitlinkPublication, queueSubmission] = submit.split("export type SubmitInspection")
    // CTO 7b4d2a85 / f9ca8343 sanctions pushRefUpdates through the checkout-bound seamProcess
    // for refs/git-super/pins (27091); queue refs still belong to the Gitomic boundary.
    // This census catches raw ref calls outside that approved seam, which event journeys cannot detect.
    expect(refCommands(gitlinkPublication ?? ""), "gitlink retention publication").toEqual(["fetch", "fetch"])
    // f9be2a8286 retries a GitHub 5xx publish: the sanctioned call is the same pushRefUpdates through seamProcess,
    // awaited through retryTransientPush, and still the only ref writer here.
    expect(gitlinkPublication).toMatch(/await retryTransientPush\(\s*\(\)\s*=>\s*pushRefUpdates\(\{/u)
    expect(gitlinkPublication).toContain("git: seamProcess(first.child, checkout)")
    expect(refCommands(queueSubmission ?? ""), "queue submission").toEqual([])

    // The run's one fetch (the composing checkout's commit) lives in settled-base.ts.
    const run = source("run.ts")
    expect(refCommands(run), "queue run").toEqual([])
    expect(source("event-run.ts")).toContain("publishCheckedChildren(")
    const settledBase = source("settled-base.ts")
    expect(refCommands(settledBase), "settled base").toEqual(["fetch"])
    expect(settledBase).toContain('await options.git(["fetch", "--quiet", composing.path, commit])')

    const publication = source("publication.ts")
    // This marker read-back is a format-agnostic ref-level check shared by both
    // adapters per 25040 §3; 25041 removes the legacy call, not this module. It
    // reads the marker by name through the seam's readRemoteCommit (25570).
    expect(refCommands(publication), "shared child publication").toEqual(["push"])
    expect(publication).toContain("readRemoteCommit(options.git, options.remote, options.marker.ref)")
    expect(publication).toContain('["push", "--recurse-submodules=only", options.remote')
  })

  it("imports Gitomic only through the configured git seam", () => {
    const modules = ["yrd-queue-core", "yrd-cli"].flatMap((name) => {
      const directory = new URL(`../../${name}/src/`, import.meta.url)
      return readdirSync(directory, { recursive: true })
        .filter((path) => /\.[cm]?[jt]sx?$/u.test(String(path)))
        .map((path) => ({
          path: `${name}/${String(path)}`,
          text: readFileSync(new URL(String(path), directory), "utf8"),
        }))
    })
    const imports = modules
      .filter(({ text }) => /(?:from|import\s*\()\s*["']gitomic(?:\/[^"']*)?["']/u.test(text))
      .map(({ path }) => path)
    expect(imports).toEqual(["yrd-queue-core/git.ts"])
    expect(source("git.ts").match(/createShellBackend\(/gu)).toHaveLength(1)
    expect(source("git.ts")).toContain("backend: GitomicBackend = createLegacyBackend(selection.executable)")
  })

  it("selects Yrd's scrubbed environment and five-minute bound for production reads", () => {
    const git = source("git.ts")
    expect(git).toContain("const GIT_ROOT_INVOCATION_MS = 5 * 60_000")
    // Bound once, so the publickey retry (25282) resolves its SSH command from attempt 1's environment.
    expect(git).toContain("const baseEnv = gitEnvironment(source, objects)")
    expect(git).toContain("remoteTimeoutMs: GIT_ROOT_INVOCATION_MS")
    expect(git).toContain("gitExecutable,")
    expect(source("events.ts")).toContain("backend: GitomicBackend = createLegacyBackend(selection.executable)")
  })
})
