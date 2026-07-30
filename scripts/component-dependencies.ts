import { existsSync } from "node:fs"
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export type ComponentDependency = Readonly<{
  name: string
  repository: string
  revision: string
  install?: readonly string[]
  packages: Readonly<Record<string, string>>
}>

const SILVERY_REVISION = "991ab039889c43c12fb4706ee6e799cbe87abd73"
const TERMLESS_REVISION = "0b006ff440aec55d309b0ce3a37fff4fe1221391"
const HOST_SINGLETON_PACKAGES = ["react", "@types/react"] as const

export const COMPONENT_DEPENDENCIES = Object.freeze([
  {
    name: "silvery",
    repository: "https://github.com/beorn/silvery.git",
    revision: SILVERY_REVISION,
    install: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    packages: {
      silvery: ".",
      "@silvery/ag": "packages/ag",
      "@silvery/ag-react": "packages/ag-react",
      "@silvery/ag-term": "packages/ag-term",
      "@silvery/ansi": "packages/ansi",
      "@silvery/color": "packages/color",
      "@silvery/command": "packages/command",
      "@silvery/commander": "packages/commander",
      "@silvery/commands": "packages/commands",
      "@silvery/config": "packages/config",
      "@silvery/create": "packages/create",
      "@silvery/headless": "packages/headless",
      "@silvery/ink": "packages/ink",
      "@silvery/scope": "packages/scope",
      "@silvery/selection": "packages/selection",
      "@silvery/signals": "packages/signals",
      "@silvery/storybook": "packages/storybook",
      "@silvery/syntax": "packages/syntax",
      "@silvery/test": "packages/test",
      "@silvery/theme": "packages/theme",
    },
  },
  {
    name: "termless",
    repository: "https://github.com/beorn/termless.git",
    revision: TERMLESS_REVISION,
    install: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    packages: {
      "@termless/alacritty": "packages/alacritty",
      "@termless/cli": "packages/cli",
      "@termless/core": ".",
      "@termless/ghostty": "packages/ghostty",
      "@termless/ghostty-native": "packages/ghostty-native",
      "@termless/kitty": "packages/kitty",
      "@termless/libvterm": "packages/libvterm",
      "@termless/peekaboo": "packages/peekaboo",
      "@termless/swash-render": "packages/swash-render",
      "@termless/test": "packages/viterm",
      "@termless/vt100": "packages/vt100",
      "@termless/vt100-rust": "packages/vt100-rust",
      "@termless/vt220": "packages/vt220",
      "@termless/vterm": "packages/vterm",
      "@termless/web-player": "packages/web-player",
      "@termless/wezterm": "packages/wezterm",
      "@termless/xtermjs": "packages/xtermjs",
    },
  },
] as const satisfies readonly ComponentDependency[])

export class ComponentProvisioningError extends Error {
  readonly code = "component-dependency-provision-failed"

  constructor(
    readonly dependency: string,
    readonly revision: string,
    message: string,
  ) {
    super(message)
    this.name = "ComponentProvisioningError"
  }
}

type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>
type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>
type ProgressReporter = (message: string) => void

async function defaultRun(argv: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [...argv],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function commandFailure(argv: readonly string[], result: CommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim()
  return `${argv.join(" ")} exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`
}

async function runOrThrow(
  run: CommandRunner,
  dependency: ComponentDependency,
  argv: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  let result: CommandResult
  try {
    result = await run(argv, cwd)
  } catch (cause) {
    throw new ComponentProvisioningError(
      dependency.name,
      dependency.revision,
      `could not start ${argv.join(" ")}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (result.exitCode !== 0) {
    throw new ComponentProvisioningError(dependency.name, dependency.revision, commandFailure(argv, result))
  }
  return result
}

function installPath(root: string, packageName: string): string {
  const segments = packageName.split("/")
  const valid =
    segments.length === 1
      ? !packageName.startsWith("@") && packageName !== "" && packageName !== "." && packageName !== ".."
      : segments.length === 2 &&
        segments[0]?.startsWith("@") === true &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  if (!valid) throw new Error(`invalid component package name '${packageName}'`)
  return join(root, "node_modules", ...segments)
}

async function exactRevision(run: CommandRunner, dependency: ComponentDependency, path: string): Promise<boolean> {
  if (!existsSync(join(path, ".git"))) return false
  const result = await run(["git", "rev-parse", "HEAD"], path)
  return result.exitCode === 0 && result.stdout.trim() === dependency.revision
}

async function checkoutDependency(
  root: string,
  dependency: ComponentDependency,
  run: CommandRunner,
  progress: ProgressReporter,
): Promise<string> {
  const dependenciesRoot = join(root, ".yrd-deps")
  const path = join(dependenciesRoot, dependency.name)
  if (!(await exactRevision(run, dependency, path))) {
    progress(`checking out ${dependency.name}@${dependency.revision.slice(0, 12)}`)
    await rm(path, { recursive: true, force: true })
    await mkdir(dependenciesRoot, { recursive: true })
    await runOrThrow(
      run,
      dependency,
      ["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout", dependency.repository, path],
      root,
    )
    await runOrThrow(run, dependency, ["git", "fetch", "--quiet", "--depth=1", "origin", dependency.revision], path)
    await runOrThrow(run, dependency, ["git", "checkout", "--quiet", "--detach", dependency.revision], path)
  }
  const actual = (await runOrThrow(run, dependency, ["git", "rev-parse", "HEAD"], path)).stdout.trim()
  if (actual !== dependency.revision) {
    throw new ComponentProvisioningError(
      dependency.name,
      dependency.revision,
      `checked out ${actual || "no revision"} instead of ${dependency.revision}`,
    )
  }
  if (dependency.install !== undefined) {
    progress(`installing ${dependency.name}@${dependency.revision.slice(0, 12)}`)
    await runOrThrow(run, dependency, dependency.install, path)
  }
  return path
}

async function linkDependencyPackages(
  candidateRoot: string,
  dependency: ComponentDependency,
  dependencyRoot: string,
  consumerRoots: readonly string[],
): Promise<void> {
  for (const [packageName, relativePath] of Object.entries(dependency.packages)) {
    const source = resolve(dependencyRoot, relativePath)
    const sourceRelative = relative(dependencyRoot, source)
    const inside = sourceRelative === "" || (!sourceRelative.startsWith("..") && !isAbsolute(sourceRelative))
    if (!inside || !existsSync(join(source, "package.json"))) {
      throw new ComponentProvisioningError(
        dependency.name,
        dependency.revision,
        `declared package '${packageName}' is missing at '${relativePath}'`,
      )
    }
    for (const consumerRoot of consumerRoots) {
      const target = installPath(consumerRoot, packageName)
      const installed =
        consumerRoot === candidateRoot ||
        (await lstat(target).then(
          () => true,
          () => false,
        ))
      if (!installed) continue
      await rm(target, { recursive: true, force: true })
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target, "dir")
    }
  }
}

async function packageRoots(root: string): Promise<string[]> {
  const packagesRoot = join(root, "packages")
  if (!existsSync(packagesRoot)) return [root]
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  return [
    root,
    ...entries
      .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
      .map((entry) => join(packagesRoot, entry.name)),
  ]
}

async function linkHostSingletons(candidateRoot: string, consumerRoots: readonly string[]): Promise<void> {
  for (const packageName of HOST_SINGLETON_PACKAGES) {
    const candidatePackage = installPath(candidateRoot, packageName)
    if (!existsSync(join(candidatePackage, "package.json"))) {
      throw new ComponentProvisioningError(
        "candidate",
        "lockfile",
        `required host singleton '${packageName}' is not installed`,
      )
    }
    const source = await realpath(candidatePackage)
    for (const consumerRoot of consumerRoots) {
      if (consumerRoot === candidateRoot) continue
      const target = installPath(consumerRoot, packageName)
      const installed = await lstat(target).then(
        () => true,
        () => false,
      )
      if (!installed) continue
      await rm(target, { recursive: true, force: true })
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target, "dir")
    }
  }
}

export async function provisionComponentDependencies(options: {
  root: string
  dependencies?: readonly ComponentDependency[]
  run?: CommandRunner
  onProgress?: ProgressReporter
}): Promise<void> {
  const root = await realpath(resolve(options.root))
  const run = options.run ?? defaultRun
  const progress = options.onProgress ?? (() => {})
  const checkouts = new Map<ComponentDependency, string>()
  for (const dependency of options.dependencies ?? COMPONENT_DEPENDENCIES) {
    try {
      const dependencyRoot = await checkoutDependency(root, dependency, run, progress)
      checkouts.set(dependency, dependencyRoot)
    } catch (cause) {
      if (cause instanceof ComponentProvisioningError) throw cause
      throw new ComponentProvisioningError(
        dependency.name,
        dependency.revision,
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }
  let consumerRoots: string[]
  try {
    consumerRoots = (await Promise.all([packageRoots(root), ...Array.from(checkouts.values(), packageRoots)])).flat()
    await linkHostSingletons(root, consumerRoots)
  } catch (cause) {
    if (cause instanceof ComponentProvisioningError) throw cause
    throw new ComponentProvisioningError(
      "candidate",
      "dependency-graph",
      cause instanceof Error ? cause.message : String(cause),
    )
  }
  for (const [dependency, dependencyRoot] of checkouts) {
    try {
      await linkDependencyPackages(root, dependency, dependencyRoot, consumerRoots)
    } catch (cause) {
      if (cause instanceof ComponentProvisioningError) throw cause
      throw new ComponentProvisioningError(
        dependency.name,
        dependency.revision,
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }
}

async function main(): Promise<void> {
  try {
    await readFile(join(process.cwd(), "package.json"), "utf8")
    await provisionComponentDependencies({
      root: process.cwd(),
      onProgress: (message) => console.error(`yrd component provisioning: ${message}`),
    })
    console.log(
      `yrd component dependencies provisioned: ${COMPONENT_DEPENDENCIES.map(
        ({ name, revision }) => `${name}@${revision.slice(0, 12)}`,
      ).join(", ")}`,
    )
  } catch (cause) {
    if (cause instanceof ComponentProvisioningError) {
      console.error(
        JSON.stringify({
          failure: {
            kind: "infrastructure",
            code: cause.code,
            dependency: cause.dependency,
            revision: cause.revision,
            message: cause.message,
          },
        }),
      )
      process.exitCode = 1
      return
    }
    throw cause
  }
}

if (import.meta.main) await main()
