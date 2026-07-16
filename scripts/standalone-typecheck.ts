import { relative, resolve } from "node:path"

export type TypecheckDiagnostic = Readonly<{
  file: string
  line: number
  column: number
  code: number
  message: string
}>

export type TypecheckBaselineBucket = Readonly<{
  file: string
  code: number
  count: number
  reason: string
}>

type TypecheckBaseline = Readonly<{
  version: 1
  buckets: readonly TypecheckBaselineBucket[]
}>

export type TypecheckComparison = Readonly<{
  knownDiagnostics: readonly TypecheckDiagnostic[]
  newDiagnostics: readonly TypecheckDiagnostic[]
  fixedBaselineCount: number
}>

const diagnosticPattern = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$/gmu

function normalizePath(root: string, file: string): string {
  return relative(root, resolve(root, file)).replaceAll("\\", "/")
}

function bucketKey(value: Pick<TypecheckDiagnostic | TypecheckBaselineBucket, "file" | "code">): string {
  return value.file + ":TS" + value.code
}

export function parseTypecheckDiagnostics(output: string, root: string): readonly TypecheckDiagnostic[] {
  const diagnostics: TypecheckDiagnostic[] = []
  for (const match of output.matchAll(diagnosticPattern)) {
    diagnostics.push({
      file: normalizePath(root, match[1]!),
      line: Number(match[2]),
      column: Number(match[3]),
      code: Number(match[4]),
      message: match[5]!,
    })
  }
  return diagnostics
}

export function compareTypecheckDiagnostics(
  diagnostics: readonly TypecheckDiagnostic[],
  baseline: readonly TypecheckBaselineBucket[],
): TypecheckComparison {
  const limits = new Map(baseline.map((bucket) => [bucketKey(bucket), bucket.count]))
  const seen = new Map<string, number>()
  const knownDiagnostics: TypecheckDiagnostic[] = []
  const newDiagnostics: TypecheckDiagnostic[] = []

  for (const diagnostic of diagnostics) {
    const key = bucketKey(diagnostic)
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count <= (limits.get(key) ?? 0)) knownDiagnostics.push(diagnostic)
    else newDiagnostics.push(diagnostic)
  }

  const fixedBaselineCount = baseline.reduce(
    (sum, bucket) => sum + Math.max(0, bucket.count - (seen.get(bucketKey(bucket)) ?? 0)),
    0,
  )
  return { knownDiagnostics, newDiagnostics, fixedBaselineCount }
}

function validateBaseline(value: unknown): TypecheckBaseline {
  if (typeof value !== "object" || value === null) throw new Error("typecheck baseline must be an object")
  const candidate = value as { version?: unknown; buckets?: unknown }
  if (candidate.version !== 1 || !Array.isArray(candidate.buckets)) {
    throw new Error("typecheck baseline must contain version 1 buckets")
  }

  const keys = new Set<string>()
  const buckets = candidate.buckets.map((raw, index): TypecheckBaselineBucket => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("baseline bucket " + index + " must be an object")
    }
    const bucket = raw as Partial<TypecheckBaselineBucket>
    const { file, code, count, reason } = bucket
    if (
      typeof file !== "string" ||
      typeof code !== "number" ||
      !Number.isSafeInteger(code) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      typeof reason !== "string" ||
      reason.trim() === ""
    ) {
      throw new Error("baseline bucket " + index + " has invalid file, code, count, or reason")
    }
    const validated = { file, code, count, reason }
    const key = bucketKey(validated)
    if (keys.has(key)) throw new Error("duplicate typecheck baseline bucket " + key)
    keys.add(key)
    return validated
  })
  return { version: 1, buckets }
}

async function runStandaloneTypecheck(): Promise<number> {
  const root = resolve(import.meta.dir, "..")
  const baseline = validateBaseline(
    await Bun.file(resolve(import.meta.dir, "standalone-typecheck-baseline.json")).json(),
  )
  const tsc = resolve(root, "node_modules/typescript/bin/tsc")
  const child = Bun.spawn([process.execPath, tsc, "--noEmit", "--pretty", "false"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const output = stdout + stderr
  const diagnostics = parseTypecheckDiagnostics(output, root)
  const reportedErrorCount = output.match(/error TS\d+:/gu)?.length ?? 0
  if (reportedErrorCount !== diagnostics.length || (exitCode !== 0 && diagnostics.length === 0)) {
    process.stderr.write(output)
    process.stderr.write(
      "standalone typecheck could not classify diagnostics (exit=" +
        exitCode +
        ", reported=" +
        reportedErrorCount +
        ", parsed=" +
        diagnostics.length +
        ")\n",
    )
    return 1
  }

  const comparison = compareTypecheckDiagnostics(diagnostics, baseline.buckets)
  const allowedCount = baseline.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  process.stdout.write(
    "standalone typecheck: " +
      comparison.knownDiagnostics.length +
      " known, " +
      comparison.newDiagnostics.length +
      " new, " +
      comparison.fixedBaselineCount +
      "/" +
      allowedCount +
      " baseline diagnostics fixed\n",
  )
  for (const bucket of baseline.buckets) {
    const actual = diagnostics.filter((diagnostic) => bucketKey(diagnostic) === bucketKey(bucket)).length
    if (actual > 0) {
      process.stdout.write(
        "KNOWN " + bucketKey(bucket) + " " + actual + "/" + bucket.count + ": " + bucket.reason + "\n",
      )
    }
  }

  if (comparison.newDiagnostics.length === 0) return 0
  process.stderr.write("New standalone typecheck diagnostics:\n")
  for (const diagnostic of comparison.newDiagnostics) {
    process.stderr.write(
      diagnostic.file +
        "(" +
        diagnostic.line +
        "," +
        diagnostic.column +
        "): error TS" +
        diagnostic.code +
        ": " +
        diagnostic.message +
        "\n",
    )
  }
  return 1
}

if (import.meta.main) process.exitCode = await runStandaloneTypecheck()
