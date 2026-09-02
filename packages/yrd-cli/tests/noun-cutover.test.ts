// @failure Retired public vocabulary or workspace identities re-enter Yrd after the pre-1.0 cutover.
// @level l2
// @consumer Yrd packages, product docs, and frozen workspace lock

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, it } from "vitest"
import { publicDependencyRefusal } from "../../../scripts/verify-public-dependencies"

const root = resolve(import.meta.dirname, "../../..")
const scannedExtensions = new Set([".json", ".md", ".ts", ".tsx", ".yml"])

function copyStandaloneWorkspace(prefix: string): string {
  const standalone = mkdtempSync(join(tmpdir(), prefix))
  copyFileSync(join(root, "package.json"), join(standalone, "package.json"))
  copyFileSync(join(root, "bun.lock"), join(standalone, "bun.lock"))
  mkdirSync(join(standalone, "scripts"))
  copyFileSync(
    join(root, "scripts", "verify-public-dependencies.ts"),
    join(standalone, "scripts", "verify-public-dependencies.ts"),
  )
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(root, "packages", entry.name, "package.json")
    if (!existsSync(manifest)) continue
    const target = join(standalone, "packages", entry.name)
    mkdirSync(target, { recursive: true })
    copyFileSync(manifest, join(target, "package.json"))
  }
  return standalone
}

function scannedFiles(path: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...scannedFiles(child))
    else if (extname(entry.name) === "" || scannedExtensions.has(extname(entry.name)) || entry.name === "bun.lock") {
      files.push(child)
    }
  }
  return files
}

describe("noun cutover ratchet", () => {
  it("refuses the hh-only typecheck entrypoint from a standalone checkout and names the root command", () => {
    const script = join(root, "scripts", "typecheck-hh.ts")
    expect(
      existsSync(script),
      "the submodule entrypoint must be executable rather than a package-script incantation",
    ).toBe(true)
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.["typecheck:hh"]).toBe("bun scripts/typecheck-hh.ts")
    const implementation = readFileSync(script, "utf8")
    expect(implementation).toContain('spawnSync("bun", ["run", "typecheck"]')
    expect(implementation).not.toContain("tsconfig.hh.json")

    const standalone = mkdtempSync(join(tmpdir(), "yrd-typecheck-hh-standalone-"))
    try {
      mkdirSync(join(standalone, "scripts"))
      copyFileSync(script, join(standalone, "scripts", "typecheck-hh.ts"))
      const git = Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: standalone, stdout: "pipe", stderr: "pipe" })
      expect(git.exitCode, git.stderr.toString()).toBe(0)

      const result = Bun.spawnSync({
        cmd: [process.execPath, "scripts/typecheck-hh.ts", "--probe"],
        cwd: standalone,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = result.stderr.toString()
      expect(result.exitCode, stderr).toBe(2)
      expect(stderr).toContain("unsupported standalone topology")
      expect(stderr).toContain(
        'cd "$(git rev-parse --show-superproject-working-tree --show-toplevel | head -1)" && bun run typecheck',
      )
    } finally {
      safeRemoveSync(standalone, { within: tmpdir(), allowMissing: true })
    }
  })

  it("keeps managed agent orchestration out of Yrd product code and docs", () => {
    const violations = [
      join(root, "README.md"),
      join(root, "ARCHITECTURE.md"),
      ...scannedFiles(join(root, "packages", "yrd-cli", "src")),
    ].flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/u)
        .flatMap((line, index) =>
          /\byrd do\b|\bManagedDo\b|YRD_DO_|\.command\("do"/u.test(line)
            ? [`${file.slice(root.length + 1)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    )

    expect(violations, "agent launch/composition does not belong in Yrd product code").toEqual([])
  })

  it("keeps Hab, Tribe, and default Ag scheduling policy out of the Yrd product runtime", () => {
    const sources = {
      invocation: readFileSync(join(root, "packages/yrd-cli/src/invocation.ts"), "utf8"),
      config: readFileSync(join(root, "packages/yrd-cli/src/config.ts"), "utf8"),
      host: readFileSync(join(root, "packages/yrd-cli/src/host.ts"), "utf8"),
      run: readFileSync(join(root, "packages/yrd-cli/src/run.ts"), "utf8"),
      bayModel: readFileSync(join(root, "packages/yrd-bay/src/model.ts"), "utf8"),
      bayPlugin: readFileSync(join(root, "packages/yrd-bay/src/plugin.ts"), "utf8"),
    }

    expect(sources.invocation).not.toMatch(/\bYrdPersona\b|HAB_NAME|HAB_WIRE|TRIBE_NAME|@dev\//u)
    // `notify:` came back on 2026-09-02 as a repository-configured notifier
    // COMMAND (@i/10-yrd/24028): a plain string yrd spawns with one outcome JSON
    // on stdin, agent-blind; the tribe side lives outside this repository
    // (hh-dev tools/yrd-notify.ts). What 074d77d6 cut, and what stays out, is
    // the signal-route table: per-event recipient lists, "submitter"/"broadcast"
    // targets and SignalRecipient identities. The word alone is not the noun.
    expect(sources.config).not.toMatch(
      /\bNotifySchema\b|\bNotifyTarget|\bSignalRecipient|\bSignalRoute|"pr\/needs-author"|\bbroadcast\b/u,
    )
    expect(sources.config).toMatch(/^\s*notify: TextSchema\.optional\(\),$/mu)
    expect(sources.host).not.toMatch(/\bcreateTribeSignalAdapter\b|\bregisterTribeSignalRecipient\b|\bYrdPersona\b/u)
    expect(sources.run).not.toMatch(/\bprSession\b|\bjoinPRSession\b/u)
    expect(sources.bayModel).not.toMatch(/\bPRSession\b|\bsessions:/u)
    expect(sources.bayPlugin).not.toMatch(/\bjoinPRSession\b|\bleavePRSession\b|\bpr\/session\//u)
    expect(existsSync(join(root, "packages/yrd-cli/src/signals.ts"))).toBe(false)
    expect(existsSync(join(root, "packages/yrd-contest"))).toBe(true)
  })

  it("keeps the optional Contest extension agent-blind at every public seam", () => {
    const contestRoot = join(root, "packages", "yrd-contest")
    const sources = {
      types: readFileSync(join(contestRoot, "src", "types.ts"), "utf8"),
      plugin: readFileSync(join(contestRoot, "src", "plugin.ts"), "utf8"),
      index: readFileSync(join(contestRoot, "src", "index.ts"), "utf8"),
      packageReadme: readFileSync(join(contestRoot, "README.md"), "utf8"),
      config: readFileSync(join(root, "packages", "yrd-cli", "src", "config.ts"), "utf8"),
      host: readFileSync(join(root, "packages", "yrd-cli", "src", "host.ts"), "utf8"),
      run: readFileSync(join(root, "packages", "yrd-cli", "src", "run.ts"), "utf8"),
      status: readFileSync(join(root, "packages", "yrd-cli", "src", "status-view.tsx"), "utf8"),
      readme: readFileSync(join(root, "README.md"), "utf8"),
    }

    expect(existsSync(join(contestRoot, "src", "ag.ts"))).toBe(false)
    expect(existsSync(join(contestRoot, "tests", "ag.test.ts"))).toBe(false)
    expect(sources.index).not.toContain("./ag.ts")
    expect(`${sources.types}\n${sources.plugin}`).not.toMatch(
      /\bcreateAgContestRunner\b|\bcompetitor\.(?:model|harness)\b|\brunner\.harness\b/u,
    )
    expect(sources.types).toMatch(
      /object\(\{\s*id: DefIdSchema,\s*runner: DefIdSchema,\s*config: JsonObjectSchema\s*\}\)/su,
    )
    expect(sources.types).toMatch(/ContestRunnerDef\s*=\s*Readonly<\{\s*id:\s*string/su)
    expect(`${sources.config}\n${sources.host}`).not.toMatch(
      /\bcreateAgContestRunner\b|\byrd-ag-runner\b|\bAgContestRunner\b/u,
    )
    expect(`${sources.run}\n${sources.status}`).not.toMatch(
      /--agents\b|ag-style competitor|\bcompetitor\.(?:model|harness)\b|header:\s*"AGENT"|header:\s*"HARNESS"/u,
    )
    expect(sources.run).not.toMatch(
      /\bguestAgArgv\b|\bguestContractPrimer\b|exactOperands\([^)]*,\s*\["ag"\]\)|accepts bare `ag`|name === "ag"|\$\{bay\} in [^`\n]*\bag\b/u,
    )
    expect(`${sources.packageReadme}\n${sources.readme}`).not.toMatch(
      /harness-and-models|uses the `ag` harness|provider\/harness evidence|pitch agents\/models|yrd(?: bay)? in [^\n]*\bag\b|exact `ag` operand|in \[<bay>\] \[ag \||Exact `in ag`/u,
    )
  })

  it("documents persistent open separately from scoped run", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8")
    const prose = readme.replaceAll(/\s+/gu, " ")

    expect(prose).toContain("`bay open` creates a persistent Bay and returns")
    expect(prose).toContain("`bay run` owns the scoped foreground lifecycle")
    expect(prose).toContain("Top-level `yrd run` acts on queue-run records")
    expect(readme).toContain("yrd bay open --bay example")
    expect(readme).toContain("yrd bay run @tracker/fix-release -- vi README.md")
    expect(prose).not.toContain("`bay open` owns the complete foreground lifecycle")
    expect(readme).not.toMatch(/^yrd(?: --name [^\n]+)? bay open[^\n]*\s--\s/mu)
  })

  it("documents public recovery and the command-event core model", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8")
    const prose = readme.replaceAll(/\s+/gu, " ")
    expect(prose).toContain("Recovery has no verb: restart re-derives it")
    expect(prose).toContain("documents Commands, Events, projection, and the private Journal transaction contract")
    expect(readme).toContain("| `@yrd/core`        | Immutable definition, Commands, Events, projection, Journal")
    expect(readme).not.toContain("Runner-lease recovery remains\nan embedded/API capability")
    expect(readme).not.toContain("documents Operations, transaction\nframes")
  })

  it("keeps retired nouns and routes out of product code and current documentation", () => {
    const queueNoun = ["li", "ne"].join("")
    const issueNoun = ["ta", "sk"].join("")
    const retiredRoleNoun = ["act", "or"].join("")
    const runnerNoun = ["exec", "utor"].join("")
    const waitOption = `--${["wa", "it"].join("")}`
    const integrateVerb = ["inte", "grate"].join("")
    const holdVerb = ["ho", "ld"].join("")
    const releaseVerb = ["re", "lease"].join("")
    const statusVerb = ["sta", "tus"].join("")
    const projectionStatus = new RegExp(`${issueNoun}[-_]?${statusVerb}`, "giu")
    const branchPrefix = new RegExp(`\\b${issueNoun}/`, "giu")
    const showVerb = ["sh", "ow"].join("")
    const logVerb = ["lo", "g"].join("")
    const evaluateVerb = ["eval", "uate"].join("")
    const competeVerb = ["com", "pete"].join("")
    const forbidden = [
      new RegExp(`\\byrd\\s+${queueNoun}s?\\b`, "iu"),
      new RegExp(`\\bqueue\\s+${queueNoun}s?\\b`, "iu"),
      new RegExp(`\\b${queueNoun}[-A-Z_]`, "u"),
      new RegExp(`\\b${queueNoun.toUpperCase()}[A-Z_]`, "u"),
      new RegExp(`\\b${queueNoun[0]?.toUpperCase()}${queueNoun.slice(1)}[A-Z_]`, "u"),
      new RegExp(`\\byrd\\s+${issueNoun}s?\\b`, "iu"),
      new RegExp(`\\b${issueNoun}\\s+(?:list|show|view|create|open|close|submit|claim|ready|status)\\b`, "iu"),
      new RegExp(`\\b${retiredRoleNoun}\\b`, "iu"),
      new RegExp(runnerNoun, "iu"),
      new RegExp(waitOption, "u"),
      new RegExp(
        `\\bqueue\\s+(?:${integrateVerb}|${holdVerb}|${releaseVerb}|${statusVerb}|${showVerb}|${logVerb})\\b`,
        "iu",
      ),
      new RegExp(`\\byrd\\s+(?:${integrateVerb}|${holdVerb}|${releaseVerb})\\b`, "iu"),
      new RegExp(`\\bcontest\\s+(?:${evaluateVerb}|${showVerb})\\b`, "iu"),
      new RegExp(`\\bissue\\s+${competeVerb}\\b`, "iu"),
      new RegExp(`\\bqueue\\s+run[^\\n]{0,80}${["--re", "try"].join("")}`, "iu"),
    ]
    const failures: string[] = []
    const lintDirective = ["next", queueNoun].join("-")
    for (const file of [
      join(root, "README.md"),
      join(root, "ARCHITECTURE.md"),
      join(root, "package.json"),
      join(root, "bun.lock"),
      ...scannedFiles(join(root, "bin")),
      ...scannedFiles(join(root, "packages")),
      ...scannedFiles(join(root, "scripts")),
    ]) {
      const relative = file.slice(root.length + 1)
      for (const [index, text] of readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
        // "HOLD THE LINE" is the user-settled 21106 banner for a paused
        // queue (an idiom, not the retired queue noun).
        const searchable = text
          .replaceAll(lintDirective, "")
          .replaceAll("HOLD THE LINE", "")
          .replaceAll(projectionStatus, "")
          .replaceAll(branchPrefix, "")
        for (const expression of forbidden) {
          const match = expression.exec(searchable)
          if (match !== null) failures.push(`${relative}:${index + 1}: ${match[0]}`)
        }
      }
    }
    // Ratchet floor, not zero: the retired-noun cutover is not yet complete.
    // Match public routes and identifier-shaped nouns rather than ordinary prose
    // words such as "line", the task/ branch prefix, or taskStatus projections.
    // NEVER raise this baseline; lower it as genuine fixes merge.
    const NOUN_CUTOVER_BASELINE = 2
    expect(failures.length, failures.join("\n")).toBeLessThanOrEqual(NOUN_CUTOVER_BASELINE)
  })

  it("accepts the checked-in workspace lock in frozen mode", () => {
    const standalone = copyStandaloneWorkspace("yrd-frozen-lock-")
    try {
      const before = readFileSync(join(standalone, "bun.lock"), "utf8")
      const result = Bun.spawnSync({
        cmd: ["bun", "install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"],
        cwd: standalone,
        stdout: "pipe",
        stderr: "pipe",
      })
      const detail = `${result.stdout.toString()}${result.stderr.toString()}`
      expect(result.exitCode, detail).toBe(0)
      expect(readFileSync(join(standalone, "bun.lock"), "utf8"), detail).toBe(before)
    } finally {
      rmSync(standalone, { recursive: true, force: true })
    }
  })

  it("installs every public test dependency or refuses a known unpublished API loudly", () => {
    const standalone = copyStandaloneWorkspace("yrd-standalone-deps-")
    try {
      const install = Bun.spawnSync({
        cmd: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
        cwd: standalone,
        stdout: "pipe",
        stderr: "pipe",
      })
      const installDetail = `${install.stdout.toString()}${install.stderr.toString()}`
      expect(install.exitCode, installDetail).toBe(0)

      const imports = Bun.spawnSync({
        cmd: [
          "bun",
          "-e",
          '["silvery/test", "silvery/term", "@termless/test"].map((specifier) => import.meta.resolve(specifier))',
        ],
        cwd: join(standalone, "packages", "yrd-cli"),
        stdout: "pipe",
        stderr: "pipe",
      })
      const importDetail = `${imports.stdout.toString()}${imports.stderr.toString()}`
      expect(imports.exitCode, importDetail).toBe(0)

      const publicApi = Bun.spawnSync({
        cmd: ["bun", "run", "postinstall"],
        cwd: standalone,
        stdout: "pipe",
        stderr: "pipe",
      })
      const publicApiDetail = `${publicApi.stdout.toString()}${publicApi.stderr.toString()}`
      expect(publicApi.exitCode, publicApiDetail).toBe(0)
    } finally {
      rmSync(standalone, { recursive: true, force: true })
    }
  })

  it("names the consumer, missing public API, and release bead in the provisioning refusal (22600)", () => {
    expect(publicDependencyRefusal({})).toBe(
      "Yrd dependency provisioning refused: Yrd main consumes silvery.MarkdownView, " +
        "but the installed silvery package predates that public API " +
        "(MarkdownView was added after 0.23.1). Release: @km/infra/22627-silvery-0232-release.",
    )
    expect(publicDependencyRefusal({ MarkdownView() {} })).toBeUndefined()
  })
})
