import { createHash, randomUUID } from "node:crypto"
import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"
import {
  CauseSchema,
  Command,
  CommandSchema,
  EventSchema,
  JsonSchema,
  observeYrdLifecycle,
  type Journal,
} from "@yrd/core"
import canonicalize from "canonicalize"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"
import { createExclusive, type Exclusive, type ExclusiveOptions } from "./lock.ts"
import {
  PROJECTION_CHECKPOINT_FILE,
  SNAPSHOT_FILE,
  SNAPSHOT_REFRESH_FRAMES,
  encodeProjectionCheckpointFile,
  encodeSnapshotFile,
  joinValuesJson,
  parseProjectionCheckpointFile,
  parseSnapshotFile,
  type SnapshotBindingView,
  type SnapshotCheckpoint,
} from "./snapshot.ts"

const VERSION = 3
const FORMAT_VERSION = 4
const SCAN_BYTES = 64 * 1024
const DEFAULT_THRESHOLD_BYTES = 10 * 1024 * 1024
const DEFAULT_THRESHOLD_FRAMES = 10_000
const MANIFEST_FILE = "events-v4.manifest.json"
const RECOVERY_FILE = "events-v4.recovery.json"
const V3_FILE = "events-v3.jsonl"
const V3_CUTOVER = Buffer.from(`{"v":${FORMAT_VERSION},"cutover":"${MANIFEST_FILE}"}\n`)
const EMPTY_DIGEST = sha256(Buffer.alloc(0))
/**
 * Identity of the frame decoder baked into every snapshot binding. Snapshot values
 * are served without per-frame re-validation, so ANY semantic change to decode()
 * / decodeFrame() / StoredFrameSchema that is not already covered by a VERSION or
 * FORMAT_VERSION bump MUST bump the trailing revision here — otherwise an old
 * cache silently serves values decoded under the previous rules.
 */
const JOURNAL_DECODER = `journal-v${FORMAT_VERSION}/frame-v${VERSION}/decode-r1`
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const IntegerSchema = z.number().int().nonnegative()
const PrivatePathSchema = z.string().regex(/^events-v4\.[a-zA-Z0-9._-]+$/)

const SegmentSchema = z
  .object({
    path: PrivatePathSchema,
    codec: z.literal("gzip"),
    codecVersion: z.string().min(1),
    codecParameters: z.literal("level=9;mtime=0"),
    rawSha256: DigestSchema,
    compressedSha256: DigestSchema,
    logicalStart: IntegerSchema,
    logicalEnd: IntegerSchema,
    rawBytes: IntegerSchema,
    frames: IntegerSchema,
    generationCreated: IntegerSchema,
    sourceGeneration: IntegerSchema,
    sourceTailIdentity: z.string().min(1),
  })
  .strict()

const TailSchema = z
  .object({
    path: PrivatePathSchema,
    identity: z.string().uuid(),
    logicalStart: IntegerSchema,
    initialSha256: DigestSchema,
  })
  .strict()

const ManifestPayloadSchema = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    generation: IntegerSchema,
    sourceGeneration: IntegerSchema,
    logicalStart: z.literal(0),
    logicalEnd: IntegerSchema,
    frames: IntegerSchema,
    segments: z.array(SegmentSchema),
    tail: TailSchema,
    tailState: z.object({ path: PrivatePathSchema }).strict(),
  })
  .strict()
const ManifestSchema = ManifestPayloadSchema.extend({ digest: DigestSchema }).strict()

const TailStatePayloadSchema = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    generation: IntegerSchema,
    tailIdentity: z.string().uuid(),
    committedBytes: IntegerSchema,
    logicalEnd: IntegerSchema,
    frames: IntegerSchema,
    lastChecksum: DigestSchema.nullable(),
  })
  .strict()
const TailStateSchema = TailStatePayloadSchema.extend({ digest: DigestSchema }).strict()

const RecoveryPayloadSchema = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    kind: z.enum(["initialize", "migrate-v3", "compact"]),
    fromGeneration: IntegerSchema,
    toGeneration: IntegerSchema,
    previousManifest: z.string().nullable(),
    previousManifestDigest: DigestSchema.nullable(),
    sourceV3Path: z.literal(V3_FILE).nullable(),
    rollbackPaths: z.array(PrivatePathSchema),
    successPaths: z.array(z.union([PrivatePathSchema, z.literal(V3_FILE)])),
    verifyStart: IntegerSchema,
    verifyEnd: IntegerSchema,
    verifyFrames: IntegerSchema,
    verifyDigest: DigestSchema,
  })
  .strict()
const RecoverySchema = RecoveryPayloadSchema.extend({ digest: DigestSchema }).strict()

const StoredFrameSchema = z
  .object({
    v: z.literal(VERSION),
    cause: CauseSchema,
    command: CommandSchema,
    events: z.array(EventSchema),
    value: JsonSchema.optional(),
    checksum: DigestSchema,
  })
  .strict()
const JournalFrameSchema = StoredFrameSchema.omit({ v: true, checksum: true })
const FreshSummarySchema = z.object({ cursor: IntegerSchema, frames: IntegerSchema, digest: DigestSchema }).strict()

type Segment = z.infer<typeof SegmentSchema>
type Manifest = z.infer<typeof ManifestSchema>
type TailState = z.infer<typeof TailStateSchema>
type Recovery = z.infer<typeof RecoverySchema>
type JournalFrame = z.infer<typeof JournalFrameSchema>

type JournalIO = Readonly<{
  write(
    file: FileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesWritten: number }>>
  read(
    file: FileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>
  datasync(file: FileHandle): Promise<void>
}>

type JournalOptions = Readonly<{
  dir: string
  lock?: ExclusiveOptions
  inject?: Readonly<{
    exclusive?: Exclusive
    io?: Partial<JournalIO>
    log?: ConditionalLogger
  }>
}>

type InternalInject = NonNullable<JournalOptions["inject"]> &
  Readonly<{
    thresholds?: Readonly<{ bytes?: number; frames?: number; snapshotFrames?: number }>
    platform?: string
    phase?: (phase: string, details: Readonly<Record<string, unknown>>) => void | Promise<void>
  }>

type Runtime = Readonly<{
  dir: string
  io: JournalIO
  log: ConditionalLogger
  phase(phase: string, details?: Readonly<Record<string, unknown>>): Promise<void>
}>

type ManifestRecord = Readonly<{ manifest: Manifest; bytes: Buffer }>
type ActiveState = Readonly<{ manifest: Manifest; manifestBytes: Buffer; state: TailState }>
type ReplayExpectation = Readonly<{ start: number; end: number; frames: number; digest: string }>
type SegmentCandidate = Readonly<{ descriptor: Segment; tempPath: string; replay: ReplayExpectation }>
type CompactionSnapshot = Readonly<{
  manifest: Manifest
  manifestBytes: Buffer
  state: TailState
  tail: FileHandle
}>

type ReadPart =
  | Readonly<{ kind: "segment"; descriptor: Segment; file: FileHandle }>
  | Readonly<{
      kind: "tail"
      path: string
      logicalStart: number
      logicalEnd: number
      rawBytes: number
      file: FileHandle
    }>

type ReadSnapshot = Readonly<{
  parts: readonly ReadPart[]
  after: number
  before: number
  logicalEnd: number
  totalFrames: number | null
  tailBytes: number
  tailFrames: number
  generation: number
  /** The pinned v4 authority, or null on the legacy v3 path (no snapshot cache there). */
  active: ActiveState | null
}>

type SnapshotCache =
  | Readonly<{
      kind: "hit"
      cursor: number
      frames: number
      values: readonly unknown[]
      valuesJson: string
      checkpoint?: SnapshotCheckpoint
    }>
  | Readonly<{ kind: "miss" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "bypass" }>

const defaultIO: JournalIO = {
  write: (file, bytes, offset, length, position) => file.write(bytes, offset, length, position),
  read: (file, bytes, offset, length, position) => file.read(bytes, offset, length, position),
  datasync: (file) => file.datasync(),
}

export function createJournal(options: JournalOptions): Journal<unknown> {
  const inject = (options.inject ?? {}) as InternalInject
  const log = inject.log?.child("journal") ?? createLogger("yrd:journal", [{ level: "warn" }])
  const exclusive = inject.exclusive ?? createExclusive(options.dir, options.lock, { log })
  const io: JournalIO = { ...defaultIO, ...inject.io }
  const thresholds = {
    bytes: threshold(inject.thresholds?.bytes, DEFAULT_THRESHOLD_BYTES, "bytes"),
    frames: threshold(inject.thresholds?.frames, DEFAULT_THRESHOLD_FRAMES, "frames"),
    snapshotFrames: threshold(inject.thresholds?.snapshotFrames, SNAPSHOT_REFRESH_FRAMES, "snapshotFrames"),
  }
  const platform = inject.platform ?? process.platform
  const runtime: Runtime = {
    dir: options.dir,
    io,
    log,
    async phase(name, details = {}) {
      await inject.phase?.(name, details)
    },
  }

  const checkpoint: NonNullable<Journal<unknown>["checkpoint"]> = {
    async load(identity) {
      const snapshot = await exclusive.run(() => acquireReadSnapshot(runtime, 0))
      try {
        if (snapshot.active === null) return undefined
        const path = join(runtime.dir, PROJECTION_CHECKPOINT_FILE)
        let text: string
        try {
          text = await readFile(path, "utf8")
        } catch (error) {
          if (isMissing(error)) return undefined
          log.warn?.("journal projection checkpoint unreadable; replaying journal authority", {
            action: "full-replay",
            reason: "checkpoint-unreadable",
            path,
            error: error instanceof Error ? error.message : String(error),
          })
          return undefined
        }
        const parsed = parseProjectionCheckpointFile(text, snapshotBindingView(snapshot.active))
        if (!parsed.ok) {
          log.warn?.("journal projection checkpoint invalid; replaying journal authority", {
            action: "full-replay",
            reason: parsed.reason,
            path,
            ...(parsed.expected === undefined ? {} : { expected: parsed.expected }),
            ...(parsed.observed === undefined ? {} : { observed: parsed.observed }),
          })
          return undefined
        }
        if (
          !(await verifyProjectionCheckpointAuthority(
            runtime,
            snapshot,
            parsed.checkpoint.cursor,
            parsed.tailPrefixSha256,
          ))
        ) {
          return undefined
        }
        if (parsed.checkpoint.identity !== identity) {
          log.warn?.("journal projection checkpoint identity changed; replaying journal authority", {
            action: "full-replay",
            reason: "checkpoint-identity-mismatch",
            path,
            expected: identity,
            observed: parsed.checkpoint.identity,
          })
          return undefined
        }
        log.debug?.("journal projection checkpoint served the cold projection", {
          action: "snapshot-hit",
          path,
          cursor: parsed.checkpoint.cursor,
          replayedFrames: 0,
        })
        return structuredClone(parsed.checkpoint)
      } finally {
        await closeParts(snapshot.parts)
      }
    },
    async save(checkpoint) {
      assertCursor(checkpoint.cursor)
      const snapshot = await exclusive.run(() => acquireReadSnapshot(runtime, 0, checkpoint.cursor))
      try {
        if (snapshot.active === null) return false
        const view = snapshotBindingView(snapshot.active)
        if (checkpoint.cursor < view.tailLogicalStart || checkpoint.cursor > view.logicalEnd) return false
        const coveredTailBytes = checkpoint.cursor - view.tailLogicalStart
        let tailPrefixSha256 = EMPTY_DIGEST
        if (coveredTailBytes > 0) {
          const tail = snapshot.parts.find((part) => part.kind === "tail")
          if (tail === undefined || tail.kind !== "tail") {
            throw new Error("yrd: v4 read snapshot is missing its pinned tail part")
          }
          tailPrefixSha256 = sha256(await readExactly(tail.file, 0, coveredTailBytes, runtime.io))
        }
        const current = await loadManifestRecord(runtime.dir)
        if (current === null || current.manifest.digest !== snapshot.active.manifest.digest) return false
        const path = join(runtime.dir, PROJECTION_CHECKPOINT_FILE)
        const text = encodeProjectionCheckpointFile({ view, cursor: checkpoint.cursor, tailPrefixSha256, checkpoint })
        await replaceDurable(runtime, PROJECTION_CHECKPOINT_FILE, Buffer.from(text))
        log.debug?.("journal projection checkpoint written", {
          action: "checkpoint-written",
          path,
          cursor: checkpoint.cursor,
        })
        return true
      } catch (error) {
        log.error?.("journal projection checkpoint write failed; journal remains authoritative", {
          action: "skipped",
          reason: "checkpoint-write-failed",
          path: join(runtime.dir, PROJECTION_CHECKPOINT_FILE),
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      } finally {
        await closeParts(snapshot.parts)
      }
    },
  }
  const journal: Journal<unknown> = {
    async *read(after = 0, before) {
      assertCursor(after)
      if (before !== undefined) assertCursor(before)

      const startedAt = performance.now()
      const snapshot = await exclusive.run(() => acquireReadSnapshot(runtime, after, before))
      await runtime.phase("after-read-snapshot", {
        generation: snapshot.generation,
        logicalEnd: snapshot.logicalEnd,
      })
      using span = log.span?.("read", { after, before: snapshot.before, size: snapshot.logicalEnd })
      void span

      let frames = 0
      try {
        const cache: SnapshotCache =
          after === 0 && snapshot.active !== null ? await loadSnapshotCache(runtime, snapshot) : { kind: "bypass" }
        let served = after
        if (cache.kind === "hit") {
          served = Math.max(after, cache.cursor)
          if (cache.values.length > 0 && cache.cursor > after) {
            frames += cache.values.length
            yield { cursor: cache.cursor, values: cache.values }
          }
        }

        const collect: string[] | null = cache.kind === "bypass" ? null : []
        let replayed = 0
        for (const part of snapshot.parts) {
          const logicalStart = part.kind === "segment" ? part.descriptor.logicalStart : part.logicalStart
          const start = Math.max(served, logicalStart)
          const end = Math.min(snapshot.before, part.kind === "segment" ? part.descriptor.logicalEnd : part.logicalEnd)
          if (start >= end) continue
          // Tail bytes are read range-exact so a warm start never re-reads the
          // snapshot-covered prefix just to slice past it; segments are immutable
          // whole-file units (verified compressed) and are only read when the range
          // actually overlaps them.
          const slice =
            part.kind === "tail"
              ? await readExactly(part.file, start - logicalStart, end - start, io)
              : (await readSegment(part.descriptor, part.file, io)).subarray(start - logicalStart, end - logicalStart)
          for await (const batch of decode([slice], start, join(runtime.dir, partPath(part)))) {
            frames += batch.values.length
            replayed += batch.values.length
            if (collect !== null) for (const value of batch.values) collect.push(JSON.stringify(value))
            yield batch
          }
        }

        if (cache.kind === "hit") {
          log.debug?.("journal snapshot cache served the cold prefix", {
            action: "snapshot-hit",
            path: join(runtime.dir, SNAPSHOT_FILE),
            cursor: cache.cursor,
            cachedFrames: cache.frames,
            replayedFrames: replayed,
          })
        }
        if (
          collect !== null &&
          snapshot.active !== null &&
          platform !== "win32" &&
          (cache.kind !== "hit" || replayed > thresholds.snapshotFrames)
        ) {
          if (snapshot.before < snapshot.active.manifest.tail.logicalStart) {
            // A snapshot ending inside the segment range would leave a partially
            // covered segment outside physical verification (a repeated bounded
            // read could then serve cached frames over corrupted covered bytes),
            // so bounded reads below the tail start never seed or refresh.
            log.debug?.("journal snapshot cache not written for a bounded read inside the segment range", {
              action: "snapshot-skipped",
              reason: "bounded-read-inside-segments",
              path: join(runtime.dir, SNAPSHOT_FILE),
              before: snapshot.before,
              tailLogicalStart: snapshot.active.manifest.tail.logicalStart,
            })
          } else {
            await writeSnapshotCache(runtime, snapshot.active, snapshot.parts, snapshot.before, {
              base: cache.kind === "hit" ? cache : null,
              chunks: collect,
              replayed,
            })
          }
        }
      } finally {
        await closeParts(snapshot.parts)
      }

      if (
        snapshot.after === 0 &&
        snapshot.before === snapshot.logicalEnd &&
        (snapshot.logicalEnd >= thresholds.bytes || (snapshot.totalFrames ?? frames) >= thresholds.frames)
      ) {
        log.warn?.("journal cold replay retained history at the compaction threshold", {
          bytes: snapshot.logicalEnd,
          frames: snapshot.totalFrames ?? frames,
          tailBytes: snapshot.tailBytes,
          tailFrames: snapshot.tailFrames,
          thresholdBytes: thresholds.bytes,
          thresholdFrames: thresholds.frames,
          action: "none",
          reason: "cold-replay-retained-history",
          coldReplayMs: performance.now() - startedAt,
          optionBTrigger: "250ms-p50-or-100000-retained-frames",
          bead: "@yrd/core/21012-monorepo/21060-journal-compaction-gc",
        })
      }
    },

    append(value, expectedCursor) {
      assertCursor(expectedCursor)
      const frame = parseFrame(value)
      const encoded = encode(frame)
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "append",
          identity: {
            command: frame.command.id,
            cause: frame.cause.id,
            op: frame.command.op,
          },
          attributes: { expectedCursor, events: frame.events.length },
          outcome: (result) => (result.appended ? "succeeded" : "progress"),
          resultAttributes: (result) => result,
        },
        async () => {
          if (platform === "win32") {
            log.error?.("journal mutation refused on an unsupported platform", {
              action: "refused",
              reason: "unsupported-platform",
              platform,
              bytes: 0,
              frames: 0,
              thresholdBytes: thresholds.bytes,
              thresholdFrames: thresholds.frames,
            })
            throw new Error("yrd: journal v4 mutation refused: unsupported platform win32")
          }
          return append(runtime, exclusive, frame, encoded, expectedCursor, thresholds)
        },
      )
    },
  }
  Object.defineProperty(journal, "checkpoint", { value: checkpoint, enumerable: false })
  return journal
}

async function append(
  runtime: Runtime,
  exclusive: Exclusive,
  frame: JournalFrame,
  encoded: Readonly<{ bytes: Buffer; checksum: string }>,
  expectedCursor: number,
  thresholds: Readonly<{ bytes: number; frames: number }>,
) {
  const prepared = await exclusive.run(async () => {
    const writable = await writableState(runtime, expectedCursor)
    if ("result" in writable) return { kind: "done" as const, result: writable.result }
    const active = writable.active
    if (active.state.committedBytes >= thresholds.bytes || active.state.frames >= thresholds.frames) {
      const tail = await open(join(runtime.dir, active.manifest.tail.path), "r")
      return {
        kind: "compact" as const,
        snapshot: {
          manifest: active.manifest,
          manifestBytes: active.manifestBytes,
          state: active.state,
          tail,
        } satisfies CompactionSnapshot,
      }
    }
    return { kind: "done" as const, result: await appendFrame(runtime, active, encoded, expectedCursor) }
  })

  if (prepared.kind === "done") return prepared.result

  let candidate: SegmentCandidate
  try {
    candidate = await candidateFromSnapshot(runtime, prepared.snapshot)
    await runtime.phase("candidate-ready", {
      expectedGeneration: prepared.snapshot.manifest.generation,
      expectedLogicalEnd: prepared.snapshot.state.logicalEnd,
      tailIdentity: prepared.snapshot.manifest.tail.identity,
      tempPath: candidate.tempPath,
    })
  } catch (error) {
    await prepared.snapshot.tail.close().catch(() => undefined)
    throw error
  }

  return exclusive.run(async () => {
    await recoverPending(runtime)
    const observed = await loadActive(runtime)
    if (
      observed.manifest.generation !== prepared.snapshot.manifest.generation ||
      observed.state.logicalEnd !== prepared.snapshot.state.logicalEnd ||
      observed.manifest.tail.identity !== prepared.snapshot.manifest.tail.identity ||
      observed.state.digest !== prepared.snapshot.state.digest
    ) {
      await removeIfExists(join(runtime.dir, candidate.tempPath))
      runtime.log.warn?.("journal compaction refused after generation CAS changed", {
        bytes: observed.state.logicalEnd,
        frames: observed.manifest.frames + observed.state.frames,
        tailBytes: observed.state.committedBytes,
        tailFrames: observed.state.frames,
        action: "refused",
        reason: "concurrent-generation-or-writer",
        expectedGeneration: prepared.snapshot.manifest.generation,
        observedGeneration: observed.manifest.generation,
        expectedLogicalEnd: prepared.snapshot.state.logicalEnd,
        observedLogicalEnd: observed.state.logicalEnd,
      })
      return { appended: false as const, cursor: observed.state.logicalEnd }
    }

    const rotated = await installGeneration(runtime, {
      kind: "compact",
      previous: observed,
      candidate,
      sourceV3Path: null,
      replay: candidate.replay,
    })
    return appendFrame(runtime, rotated, encoded, expectedCursor)
  })
}

async function writableState(
  runtime: Runtime,
  expectedCursor: number,
): Promise<Readonly<{ active: ActiveState }> | Readonly<{ result: { appended: false; cursor: number } }>> {
  await recoverPending(runtime)
  const current = await loadManifestRecord(runtime.dir)
  if (current !== null) {
    await ensureV3Cutover(runtime)
    const active = await loadActive(runtime, current)
    if (active.state.logicalEnd !== expectedCursor) {
      return { result: { appended: false as const, cursor: active.state.logicalEnd } }
    }
    return { active }
  }

  const legacy = await readLegacy(runtime, true)
  if (legacy.end !== expectedCursor) return { result: { appended: false as const, cursor: legacy.end } }
  const built = await buildCandidate(runtime, legacy.raw, 0, 1, 3, V3_FILE)
  if (built.candidate !== null) {
    await runtime.phase("candidate-ready", {
      expectedGeneration: 0,
      expectedLogicalEnd: legacy.end,
      tailIdentity: V3_FILE,
      tempPath: built.candidate.tempPath,
    })
  }
  const active = await installGeneration(runtime, {
    kind: legacy.exists ? "migrate-v3" : "initialize",
    previous: null,
    candidate: built.candidate,
    sourceV3Path: legacy.exists ? V3_FILE : null,
    replay: built.replay,
  })
  return { active }
}

async function appendFrame(
  runtime: Runtime,
  active: ActiveState,
  encoded: Readonly<{ bytes: Buffer; checksum: string }>,
  expectedCursor: number,
) {
  if (active.state.logicalEnd !== expectedCursor) {
    return { appended: false as const, cursor: active.state.logicalEnd }
  }

  const path = join(runtime.dir, active.manifest.tail.path)
  const file = await open(path, "r+")
  try {
    await writeAll(file, encoded.bytes, active.state.committedBytes, runtime.io)
    await runtime.io.datasync(file)
    const next = createTailState({
      generation: active.manifest.generation,
      tailIdentity: active.manifest.tail.identity,
      committedBytes: active.state.committedBytes + encoded.bytes.length,
      logicalEnd: active.state.logicalEnd + encoded.bytes.length,
      frames: active.state.frames + 1,
      lastChecksum: encoded.checksum,
    })
    await runtime.phase("before-tail-state-replace", {
      generation: active.manifest.generation,
      previousLogicalEnd: active.state.logicalEnd,
      nextLogicalEnd: next.logicalEnd,
      tailPath: active.manifest.tail.path,
      statePath: active.manifest.tailState.path,
    })
    await replaceDurable(runtime, active.manifest.tailState.path, encodeJson(next))
    return { appended: true as const, cursor: next.logicalEnd }
  } finally {
    await file.close()
  }
}

async function candidateFromSnapshot(runtime: Runtime, snapshot: CompactionSnapshot): Promise<SegmentCandidate> {
  try {
    const raw = await readExactly(snapshot.tail, 0, snapshot.state.committedBytes, runtime.io)
    const built = await buildCandidate(
      runtime,
      raw,
      snapshot.manifest.logicalEnd,
      snapshot.manifest.generation + 1,
      snapshot.manifest.generation,
      snapshot.manifest.tail.identity,
    )
    if (built.candidate === null) throw new Error("yrd: cannot compact an empty journal tail")
    return built.candidate
  } finally {
    await snapshot.tail.close()
  }
}

async function buildCandidate(
  runtime: Runtime,
  raw: Buffer,
  logicalStart: number,
  generationCreated: number,
  sourceGeneration: number,
  sourceTailIdentity: string,
): Promise<Readonly<{ candidate: SegmentCandidate | null; replay: ReplayExpectation }>> {
  if (raw.length === 0) {
    return {
      candidate: null,
      replay: { start: logicalStart, end: logicalStart, frames: 0, digest: digest([]) },
    }
  }
  if (raw.at(-1) !== 10) throw new Error("yrd: committed journal tail is not newline-terminated")
  const values = await decodeValues(raw, logicalStart, sourceTailIdentity)
  const compressed = gzipSync(raw, { level: 9 })
  const rawSha256 = sha256(raw)
  const compressedSha256 = sha256(compressed)
  const descriptor = SegmentSchema.parse({
    path: `events-v4.segment-${rawSha256}.jsonl.gz`,
    codec: "gzip",
    codecVersion: process.versions.zlib,
    codecParameters: "level=9;mtime=0",
    rawSha256,
    compressedSha256,
    logicalStart,
    logicalEnd: logicalStart + raw.length,
    rawBytes: raw.length,
    frames: values.length,
    generationCreated,
    sourceGeneration,
    sourceTailIdentity,
  })
  const tempPath = await writeDurableTemp(runtime, compressed)
  const replay = {
    start: logicalStart,
    end: logicalStart + raw.length,
    frames: values.length,
    digest: digest(values),
  }
  return { candidate: { descriptor, tempPath, replay }, replay }
}

async function installGeneration(
  runtime: Runtime,
  input: Readonly<{
    kind: "initialize" | "migrate-v3" | "compact"
    previous: ActiveState | null
    candidate: SegmentCandidate | null
    sourceV3Path: typeof V3_FILE | null
    replay: ReplayExpectation
  }>,
): Promise<ActiveState> {
  const fromGeneration = input.previous?.manifest.generation ?? 0
  const toGeneration = fromGeneration + 1
  const segments = [...(input.previous?.manifest.segments ?? [])]
  const rollbackPaths: string[] = []
  let recoveryDurable = false

  try {
    if (input.candidate !== null) {
      const created = await installCandidate(runtime, input.candidate)
      segments.push(input.candidate.descriptor)
      if (created) rollbackPaths.push(input.candidate.descriptor.path)
    }

    const logicalEnd = input.replay.end
    const generated = await createGenerationFiles(runtime, toGeneration, logicalEnd)
    rollbackPaths.push(generated.tail.path, generated.statePath)
    const manifest = createManifest({
      generation: toGeneration,
      sourceGeneration: input.previous?.manifest.generation ?? (input.sourceV3Path === null ? 0 : 3),
      logicalEnd,
      frames: segments.reduce((total, segment) => total + segment.frames, 0),
      segments,
      tail: generated.tail,
      statePath: generated.statePath,
    })
    const manifestBytes = encodeJson(manifest)
    const previousManifest = input.previous === null ? null : input.previous.manifestBytes.toString("utf8")
    const successPaths = [
      ...(input.previous === null ? [] : [input.previous.manifest.tail.path, input.previous.manifest.tailState.path]),
      ...(input.sourceV3Path === null ? [] : [input.sourceV3Path]),
    ]
    const recovery = createRecovery({
      kind: input.kind,
      fromGeneration,
      toGeneration,
      previousManifest,
      sourceV3Path: input.sourceV3Path,
      rollbackPaths,
      successPaths,
      replay: input.replay,
    })
    await replaceDurable(runtime, RECOVERY_FILE, encodeJson(recovery))
    recoveryDurable = true

    await runtime.phase("before-manifest-replace", { fromGeneration, toGeneration, manifestPath: MANIFEST_FILE })
    await replaceDurable(runtime, MANIFEST_FILE, manifestBytes)
    await runtime.phase("after-manifest-replace", { fromGeneration, toGeneration, manifestPath: MANIFEST_FILE })
    await runtime.phase("before-verification", {
      fromGeneration,
      toGeneration,
      manifestPath: MANIFEST_FILE,
      segmentPaths: manifest.segments.map((segment) => segment.path),
      tailPath: manifest.tail.path,
      statePath: manifest.tailState.path,
    })

    try {
      await verifyFreshProcess(runtime.dir, manifest, input.replay)
    } catch (cause) {
      await rollbackGeneration(runtime, recovery, cause)
      throw new Error("yrd: journal production verification failed; previous authority restored", { cause })
    }

    await runtime.phase("before-cleanup", { fromGeneration, toGeneration, recoveryPath: RECOVERY_FILE })
    await finalizeGeneration(runtime, recovery, manifest)
    await removeIfExists(join(runtime.dir, RECOVERY_FILE))
    await syncDirectory(runtime.dir)
    runtime.log.warn?.("journal generation installed and verified", {
      bytes: input.replay.end,
      frames: segments.reduce((total, segment) => total + segment.frames, 0),
      tailBytes: 0,
      tailFrames: 0,
      action: input.kind === "compact" ? "compacted" : "recovered",
      reason: input.kind,
      fromGeneration,
      toGeneration,
      expectedLogicalEnd: input.replay.end,
      observedLogicalEnd: input.replay.end,
      manifestPath: join(runtime.dir, MANIFEST_FILE),
      recoveryPath: join(runtime.dir, RECOVERY_FILE),
      rawSha256: input.candidate?.descriptor.rawSha256,
      compressedSha256: input.candidate?.descriptor.compressedSha256,
      codec: input.candidate?.descriptor.codec,
      codecVersion: input.candidate?.descriptor.codecVersion,
      sourceBytesRead: input.candidate?.descriptor.rawBytes ?? 0,
      priorSegmentBytesRead: 0,
      priorSegmentsRewritten: 0,
    })
    return loadActive(runtime, { manifest, bytes: manifestBytes })
  } catch (error) {
    if (!recoveryDurable) {
      await removePaths(runtime, rollbackPaths)
      if (input.candidate !== null) await removeIfExists(join(runtime.dir, input.candidate.tempPath))
      if (rollbackPaths.length > 0) await syncDirectory(runtime.dir)
    }
    throw error
  }
}

async function installCandidate(runtime: Runtime, candidate: SegmentCandidate): Promise<boolean> {
  const finalPath = join(runtime.dir, candidate.descriptor.path)
  try {
    const existing = await readFile(finalPath)
    if (sha256(existing) !== candidate.descriptor.compressedSha256) {
      throw new Error(`yrd: immutable segment digest conflict at ${finalPath}`)
    }
    await removeIfExists(join(runtime.dir, candidate.tempPath))
    return false
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await rename(join(runtime.dir, candidate.tempPath), finalPath)
  return true
}

async function finalizeGeneration(runtime: Runtime, recovery: Recovery, manifest: Manifest): Promise<void> {
  if (recovery.sourceV3Path !== null) await sealMigratedV3(runtime, recovery, manifest)
  await removePaths(
    runtime,
    recovery.successPaths.filter((path) => path !== V3_FILE),
  )
  // The snapshot cache is bound to the replaced generation; remove it deliberately so
  // the next replay reseeds quietly instead of tripping the loud staleness fallback.
  await removeIfExists(join(runtime.dir, SNAPSHOT_FILE))
  await removeIfExists(join(runtime.dir, PROJECTION_CHECKPOINT_FILE))
}

async function sealMigratedV3(runtime: Runtime, recovery: Recovery, manifest: Manifest): Promise<void> {
  const path = join(runtime.dir, V3_FILE)
  let raw: Buffer | undefined
  try {
    raw = await readFile(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (raw?.equals(V3_CUTOVER) === true) return
  if (raw !== undefined) {
    const source = manifest.segments.find(
      (segment) => segment.sourceGeneration === 3 && segment.sourceTailIdentity === V3_FILE,
    )
    if (raw.length !== recovery.verifyEnd || (source !== undefined && sha256(raw) !== source.rawSha256)) {
      throw new Error(`yrd: legacy v3 journal changed during v4 cutover at ${path}; preserve it for reconciliation`)
    }
  }
  await installV3Cutover(runtime)
}

async function ensureV3Cutover(runtime: Runtime): Promise<void> {
  const path = join(runtime.dir, V3_FILE)
  let raw: Buffer
  try {
    raw = await readFile(path)
  } catch (error) {
    if (!isMissing(error)) throw error
    await installV3Cutover(runtime)
    return
  }
  if (raw.equals(V3_CUTOVER)) return
  throw new Error(`yrd: legacy v3 journal changed after v4 cutover at ${path}; preserve it for reconciliation`)
}

async function installV3Cutover(runtime: Runtime): Promise<void> {
  const temp = await writeDurableTemp(runtime, V3_CUTOVER)
  const source = join(runtime.dir, temp)
  try {
    await chmod(source, 0o444)
    await rename(source, join(runtime.dir, V3_FILE))
    await syncDirectory(runtime.dir)
  } catch (error) {
    await removeIfExists(source)
    throw error
  }
}

async function createGenerationFiles(runtime: Runtime, generation: number, logicalStart: number) {
  const identity = randomUUID()
  const tail = TailSchema.parse({
    path: `events-v4.tail-${generation}-${identity}.jsonl`,
    identity,
    logicalStart,
    initialSha256: EMPTY_DIGEST,
  })
  const statePath = `events-v4.state-${generation}-${identity}.json`
  const installed: string[] = []
  try {
    const tailTemp = await writeDurableTemp(runtime, Buffer.alloc(0))
    await rename(join(runtime.dir, tailTemp), join(runtime.dir, tail.path))
    installed.push(tail.path)
    const state = createTailState({
      generation,
      tailIdentity: identity,
      committedBytes: 0,
      logicalEnd: logicalStart,
      frames: 0,
      lastChecksum: null,
    })
    const stateTemp = await writeDurableTemp(runtime, encodeJson(state))
    await rename(join(runtime.dir, stateTemp), join(runtime.dir, statePath))
    installed.push(statePath)
    await syncDirectory(runtime.dir)
    return { tail, statePath, state }
  } catch (error) {
    await removePaths(runtime, installed)
    throw error
  }
}

async function recoverPending(runtime: Runtime): Promise<void> {
  const recovery = await loadRecovery(runtime.dir)
  if (recovery === null) return

  let current: ManifestRecord | null
  try {
    current = await loadManifestRecord(runtime.dir)
  } catch (cause) {
    await rollbackGeneration(runtime, recovery, cause)
    throw new Error("yrd: active journal generation was corrupt and has been restored", { cause })
  }

  if (current?.manifest.generation === recovery.toGeneration) {
    try {
      await verifyFreshProcess(runtime.dir, current.manifest, {
        start: recovery.verifyStart,
        end: recovery.verifyEnd,
        frames: recovery.verifyFrames,
        digest: recovery.verifyDigest,
      })
    } catch (cause) {
      await rollbackGeneration(runtime, recovery, cause)
      throw new Error("yrd: interrupted journal generation failed verification and was restored", { cause })
    }
    await finalizeGeneration(runtime, recovery, current.manifest)
    await removeIfExists(join(runtime.dir, RECOVERY_FILE))
    await syncDirectory(runtime.dir)
    runtime.log.warn?.("journal recovered a verified interrupted generation", {
      action: "recovered",
      reason: "post-switch-interruption",
      fromGeneration: recovery.fromGeneration,
      toGeneration: recovery.toGeneration,
      expectedLogicalEnd: recovery.verifyEnd,
      observedLogicalEnd: recovery.verifyEnd,
      recoveryPath: join(runtime.dir, RECOVERY_FILE),
    })
    return
  }

  if ((current === null && recovery.fromGeneration === 0) || current?.manifest.generation === recovery.fromGeneration) {
    await removePaths(runtime, recovery.rollbackPaths)
    await removeIfExists(join(runtime.dir, RECOVERY_FILE))
    await syncDirectory(runtime.dir)
    runtime.log.warn?.("journal recovered an interrupted pre-switch generation", {
      action: "recovered",
      reason: "pre-switch-interruption",
      fromGeneration: recovery.fromGeneration,
      toGeneration: recovery.toGeneration,
      recoveryPath: join(runtime.dir, RECOVERY_FILE),
    })
    return
  }

  const cause = new Error(
    `yrd: recovery generation mismatch (active=${current?.manifest.generation ?? "none"}, from=${recovery.fromGeneration}, to=${recovery.toGeneration})`,
  )
  await rollbackGeneration(runtime, recovery, cause)
  throw cause
}

async function rollbackGeneration(runtime: Runtime, recovery: Recovery, cause: unknown): Promise<void> {
  const suffix = `${recovery.toGeneration}-${randomUUID()}`
  const failedManifest = `events-v4.failed-${suffix}.manifest.json`
  const failedRecovery = `events-v4.failed-${suffix}.recovery.json`
  let preservedManifest: string | null = null
  try {
    await rename(join(runtime.dir, MANIFEST_FILE), join(runtime.dir, failedManifest))
    preservedManifest = failedManifest
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  if (recovery.previousManifest !== null) {
    await replaceDurable(runtime, MANIFEST_FILE, Buffer.from(recovery.previousManifest))
  }
  try {
    await rename(join(runtime.dir, RECOVERY_FILE), join(runtime.dir, failedRecovery))
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await syncDirectory(runtime.dir)

  if (recovery.previousManifest !== null) {
    await loadActive(runtime)
  } else if (recovery.sourceV3Path !== null) {
    const legacy = await readLegacy(runtime, false)
    await decodeValues(legacy.raw, 0, recovery.sourceV3Path)
  }

  runtime.log.error?.("journal generation verification failed; previous authority restored", {
    action: "refused",
    reason: "production-verification-failed",
    fromGeneration: recovery.fromGeneration,
    toGeneration: recovery.toGeneration,
    expectedLogicalEnd: recovery.verifyEnd,
    manifestPath: preservedManifest === null ? null : join(runtime.dir, preservedManifest),
    recoveryPath: join(runtime.dir, failedRecovery),
    error: cause instanceof Error ? cause.message : String(cause),
  })
}

function snapshotBindingView(active: ActiveState): SnapshotBindingView {
  return {
    decoder: JOURNAL_DECODER,
    generation: active.manifest.generation,
    manifestDigest: active.manifest.digest,
    tailIdentity: active.manifest.tail.identity,
    tailLogicalStart: active.manifest.tail.logicalStart,
    logicalEnd: active.state.logicalEnd,
    segments: active.manifest.segments.map((segment) => ({
      path: segment.path,
      logicalStart: segment.logicalStart,
      logicalEnd: segment.logicalEnd,
      compressedSha256: segment.compressedSha256,
    })),
  }
}

async function verifyProjectionCheckpointAuthority(
  runtime: Runtime,
  snapshot: ReadSnapshot,
  cursor: number,
  tailPrefixSha256: string,
): Promise<boolean> {
  const path = join(runtime.dir, PROJECTION_CHECKPOINT_FILE)
  for (const part of snapshot.parts) {
    if (part.kind !== "segment") continue
    const compressed = await readWhole(part.file, runtime.io)
    const observed = sha256(compressed)
    if (observed !== part.descriptor.compressedSha256) {
      runtime.log.warn?.("journal projection checkpoint rejected: covered segment bytes changed on disk", {
        action: "full-replay",
        reason: "checkpoint-covered-segment-checksum",
        path,
        segment: part.descriptor.path,
        expected: part.descriptor.compressedSha256,
        observed,
      })
      return false
    }
  }
  const view = snapshotBindingView(snapshot.active!)
  const coveredTailBytes = Math.max(0, cursor - view.tailLogicalStart)
  if (coveredTailBytes === 0) return true
  const tail = snapshot.parts.find((part) => part.kind === "tail")
  if (tail === undefined || tail.kind !== "tail")
    throw new Error("yrd: v4 read snapshot is missing its pinned tail part")
  const observed = sha256(await readExactly(tail.file, 0, coveredTailBytes, runtime.io))
  if (observed === tailPrefixSha256) return true
  runtime.log.warn?.("journal projection checkpoint rejected: covered tail bytes changed on disk", {
    action: "full-replay",
    reason: "checkpoint-covered-tail-checksum",
    path,
    expected: tailPrefixSha256,
    observed,
    coveredBytes: coveredTailBytes,
  })
  return false
}

/**
 * Loads and validates the snapshot cache against the pinned read snapshot.
 * Invalid or stale caches warn LOUDLY (naming exactly what mismatched) and
 * make the caller fall back to a full replay plus an atomic rewrite; only a
 * plain missing file (normal first run) stays quiet at debug level.
 */
async function loadSnapshotCache(
  runtime: Runtime,
  snapshot: ReadSnapshot,
  reportInvalid = true,
): Promise<SnapshotCache> {
  const active = snapshot.active
  if (active === null) throw new Error("yrd: the journal snapshot cache requires an active v4 generation")
  const path = join(runtime.dir, SNAPSHOT_FILE)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) {
      runtime.log.debug?.("journal snapshot cache missing; full replay will seed it", {
        action: "snapshot-miss",
        path,
      })
      return { kind: "miss" }
    }
    if (reportInvalid) {
      runtime.log.warn?.("journal snapshot cache unreadable; falling back to full replay", {
        action: "full-replay",
        reason: "snapshot-unreadable",
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return { kind: "invalid" }
  }

  const view = snapshotBindingView(active)
  const parsed = parseSnapshotFile(text, view)
  if (!parsed.ok) {
    if (reportInvalid) {
      runtime.log.warn?.("journal snapshot cache invalid; falling back to full replay and rewriting", {
        action: "full-replay",
        reason: parsed.reason,
        path,
        ...(parsed.expected === undefined ? {} : { expected: parsed.expected }),
        ...(parsed.observed === undefined ? {} : { observed: parsed.observed }),
      })
    }
    return { kind: "invalid" }
  }
  if (parsed.cursor > snapshot.before) {
    runtime.log.debug?.("journal snapshot cache covers more than the requested range; reading raw", {
      action: "snapshot-bypass",
      path,
      cursor: parsed.cursor,
      before: snapshot.before,
    })
    return { kind: "bypass" }
  }

  // Physical verification: covered journal bytes must still match the binding so the
  // cache can never mask on-disk corruption that a raw replay would have detected.
  // parseSnapshotFile guarantees cursor >= tailLogicalStart, so every segment is
  // fully covered and every one of them is verified here.
  for (const part of snapshot.parts) {
    if (part.kind !== "segment") continue
    const compressed = await readWhole(part.file, runtime.io)
    if (sha256(compressed) !== part.descriptor.compressedSha256) {
      if (reportInvalid) {
        runtime.log.warn?.("journal snapshot cache rejected: covered segment bytes changed on disk", {
          action: "full-replay",
          reason: "snapshot-covered-segment-checksum",
          path,
          segment: part.descriptor.path,
          expected: part.descriptor.compressedSha256,
          observed: sha256(compressed),
        })
      }
      return { kind: "invalid" }
    }
  }
  const coveredTailBytes = Math.max(0, parsed.cursor - view.tailLogicalStart)
  if (coveredTailBytes > 0) {
    const tail = snapshot.parts.find((part) => part.kind === "tail")
    if (tail === undefined || tail.kind !== "tail") {
      throw new Error("yrd: v4 read snapshot is missing its pinned tail part")
    }
    const prefix = await readExactly(tail.file, 0, coveredTailBytes, runtime.io)
    const observed = sha256(prefix)
    if (observed !== parsed.tailPrefixSha256) {
      if (reportInvalid) {
        runtime.log.warn?.("journal snapshot cache rejected: covered tail bytes changed on disk", {
          action: "full-replay",
          reason: "snapshot-covered-tail-checksum",
          path,
          expected: parsed.tailPrefixSha256,
          observed,
          coveredBytes: coveredTailBytes,
        })
      }
      return { kind: "invalid" }
    }
  }
  return {
    kind: "hit",
    cursor: parsed.cursor,
    frames: parsed.frames,
    values: parsed.values,
    valuesJson: parsed.valuesJson,
    ...(parsed.checkpoint === undefined ? {} : { checkpoint: parsed.checkpoint }),
  }
}

/**
 * Atomically (temp file + rename) rewrites the snapshot cache to cover [0, before).
 * Concurrent writers are safe: each writes its own temp and the last rename wins,
 * and every candidate is self-consistent and bound to the generation it read.
 * A write failure is loudly logged but never fails the read — the journal remains
 * the authority and the next replay simply reseeds the cache.
 */
async function writeSnapshotCache(
  runtime: Runtime,
  active: ActiveState,
  parts: readonly ReadPart[],
  before: number,
  input: Readonly<{
    base: Readonly<{ frames: number; valuesJson: string; checkpoint?: SnapshotCheckpoint }> | null
    chunks: readonly string[]
    replayed: number
    checkpoint?: SnapshotCheckpoint
  }>,
): Promise<boolean> {
  const path = join(runtime.dir, SNAPSHOT_FILE)
  try {
    const view = snapshotBindingView(active)
    const coveredTailBytes = Math.max(0, before - view.tailLogicalStart)
    let tailPrefixSha256 = EMPTY_DIGEST
    if (coveredTailBytes > 0) {
      const tail = parts.find((part) => part.kind === "tail")
      if (tail === undefined || tail.kind !== "tail") {
        throw new Error("yrd: v4 read snapshot is missing its pinned tail part")
      }
      tailPrefixSha256 = sha256(await readExactly(tail.file, 0, coveredTailBytes, runtime.io))
    }
    const valuesJson =
      input.base === null ? `[${input.chunks.join(",")}]` : joinValuesJson(input.base.valuesJson, input.chunks)
    const frames = (input.base?.frames ?? 0) + input.replayed
    const checkpoint = input.checkpoint ?? input.base?.checkpoint
    const text = encodeSnapshotFile({
      view,
      cursor: before,
      frames,
      valuesJson,
      tailPrefixSha256,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    })
    // A reader pinned across a concurrent compaction would bind to the replaced
    // generation; skip the write when the on-disk authority moved on (best effort —
    // a raced stale write is still caught loudly by binding validation on next read).
    const current = await loadManifestRecord(runtime.dir)
    if (current === null || current.manifest.digest !== active.manifest.digest) {
      runtime.log.debug?.("journal snapshot cache write skipped after a generation change", {
        action: "snapshot-skipped",
        path,
        expectedGeneration: active.manifest.generation,
        observedGeneration: current?.manifest.generation ?? null,
      })
      return false
    }
    await replaceDurable(runtime, SNAPSHOT_FILE, Buffer.from(text))
    runtime.log.debug?.("journal snapshot cache written", {
      action: input.base === null ? "snapshot-seeded" : "snapshot-refreshed",
      path,
      cursor: before,
      frames,
      replayedFrames: input.replayed,
    })
    return true
  } catch (error) {
    // Loud but non-fatal by design: the read already returned correct data and the
    // journal stays authoritative; a failed cache write must not fail the caller.
    runtime.log.error?.("journal snapshot cache write failed; journal remains authoritative", {
      action: "skipped",
      reason: "snapshot-write-failed",
      path,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function acquireReadSnapshot(runtime: Runtime, after: number, before?: number): Promise<ReadSnapshot> {
  await recoverPending(runtime)
  const manifestRecord = await loadManifestRecord(runtime.dir)
  if (manifestRecord === null) {
    const path = join(runtime.dir, V3_FILE)
    let file: FileHandle
    try {
      file = await open(path, "r")
    } catch (error) {
      if (!isMissing(error)) throw error
      validateRange(after, before ?? 0, 0)
      return {
        parts: [],
        after,
        before: before ?? 0,
        logicalEnd: 0,
        totalFrames: 0,
        tailBytes: 0,
        tailFrames: 0,
        generation: 3,
        active: null,
      }
    }
    try {
      const logicalEnd = await committedExtent(file)
      const end = before ?? logicalEnd
      validateRange(after, end, logicalEnd)
      return {
        parts: [{ kind: "tail", path: V3_FILE, logicalStart: 0, logicalEnd, rawBytes: logicalEnd, file }],
        after,
        before: end,
        logicalEnd,
        totalFrames: null,
        tailBytes: logicalEnd,
        tailFrames: 0,
        generation: 3,
        active: null,
      }
    } catch (error) {
      await file.close()
      throw error
    }
  }

  await ensureV3Cutover(runtime)
  const active = await loadActive(runtime, manifestRecord)
  const logicalEnd = active.state.logicalEnd
  const end = before ?? logicalEnd
  validateRange(after, end, logicalEnd)
  const parts: ReadPart[] = []
  try {
    for (const descriptor of active.manifest.segments) {
      parts.push({ kind: "segment", descriptor, file: await open(join(runtime.dir, descriptor.path), "r") })
    }
    parts.push({
      kind: "tail",
      path: active.manifest.tail.path,
      logicalStart: active.manifest.tail.logicalStart,
      logicalEnd: active.state.logicalEnd,
      rawBytes: active.state.committedBytes,
      file: await open(join(runtime.dir, active.manifest.tail.path), "r"),
    })
    return {
      parts,
      after,
      before: end,
      logicalEnd,
      totalFrames: active.manifest.frames + active.state.frames,
      tailBytes: active.state.committedBytes,
      tailFrames: active.state.frames,
      generation: active.manifest.generation,
      active,
    }
  } catch (error) {
    await closeParts(parts)
    throw error
  }
}

async function readSegment(descriptor: Segment, file: FileHandle, io: JournalIO): Promise<Buffer> {
  const compressed = await readWhole(file, io)
  if (sha256(compressed) !== descriptor.compressedSha256) {
    throw new Error(`yrd: compressed segment checksum mismatch (${descriptor.path})`)
  }
  const raw = gunzipSync(compressed)
  if (raw.length !== descriptor.rawBytes || sha256(raw) !== descriptor.rawSha256) {
    throw new Error(`yrd: raw segment checksum mismatch (${descriptor.path})`)
  }
  return raw
}

async function loadActive(runtime: Runtime, record?: ManifestRecord): Promise<ActiveState> {
  const manifestRecord = record ?? (await loadManifestRecord(runtime.dir))
  if (manifestRecord === null) throw new Error("yrd: v4 manifest is missing")
  const state = await loadTailState(runtime.dir, manifestRecord.manifest.tailState.path)
  validateActive(manifestRecord.manifest, state)

  const path = join(runtime.dir, manifestRecord.manifest.tail.path)
  const file = await open(path, "r+")
  try {
    const { size } = await file.stat()
    if (size < state.committedBytes) {
      runtime.log.error?.("journal tail is shorter than its durable state", {
        action: "refused",
        reason: "tail-shorter-than-state",
        generation: manifestRecord.manifest.generation,
        tailPath: path,
        expectedBytes: state.committedBytes,
        observedBytes: size,
      })
      throw new Error(`yrd: journal tail ${path} is shorter than committed state (${size} < ${state.committedBytes})`)
    }
    if (size > state.committedBytes) {
      await file.truncate(state.committedBytes)
      await runtime.io.datasync(file)
      runtime.log.warn?.("journal truncated bytes beyond the durable tail state", {
        bytes: state.logicalEnd,
        frames: manifestRecord.manifest.frames + state.frames,
        tailBytes: state.committedBytes,
        tailFrames: state.frames,
        action: "recovered",
        reason: "uncommitted-tail",
        generation: manifestRecord.manifest.generation,
        tailPath: path,
        truncatedBytes: size - state.committedBytes,
      })
    }
  } finally {
    await file.close()
  }
  return { manifest: manifestRecord.manifest, manifestBytes: manifestRecord.bytes, state }
}

async function readLegacy(runtime: Runtime, repair: boolean) {
  const path = join(runtime.dir, V3_FILE)
  let file: FileHandle
  try {
    file = await open(path, repair ? "r+" : "r")
  } catch (error) {
    if (isMissing(error)) return { exists: false, raw: Buffer.alloc(0), end: 0 }
    throw error
  }
  try {
    const { size } = await file.stat()
    const end = await committedExtent(file)
    if (repair && end !== size) {
      await file.truncate(end)
      await runtime.io.datasync(file)
      runtime.log.warn?.("journal repaired an uncommitted v3 tail before migration", {
        bytes: end,
        frames: 0,
        tailBytes: end,
        tailFrames: 0,
        action: "recovered",
        reason: "uncommitted-v3-tail",
        path,
        truncatedBytes: size - end,
      })
    }
    return { exists: true, raw: await readExactly(file, 0, end, runtime.io), end }
  } finally {
    await file.close()
  }
}

async function verifyFreshProcess(dir: string, manifest: Manifest, expected: ReplayExpectation): Promise<void> {
  const verifyDir = join(dir, `.events-v4-verify-${randomUUID()}`)
  await mkdir(verifyDir)
  try {
    const paths = new Set([
      ...manifest.segments.map((segment) => segment.path),
      manifest.tail.path,
      manifest.tailState.path,
    ])
    for (const path of paths) await link(join(dir, path), join(verifyDir, path))
    await copyFile(join(dir, MANIFEST_FILE), join(verifyDir, MANIFEST_FILE))

    const source = `
      import { createHash } from "node:crypto"
      import canonicalize from "canonicalize"
      import { createJournal } from ${JSON.stringify(import.meta.url)}
      const values = []
      let cursor = ${expected.start}
      const journal = createJournal({ dir: ${JSON.stringify(verifyDir)} })
      for await (const batch of journal.read(${expected.start}, ${expected.end})) {
        cursor = batch.cursor
        values.push(...batch.values)
      }
      const encoded = canonicalize(values)
      if (encoded === undefined) throw new Error("yrd: verification values are not canonical JSON")
      console.log(JSON.stringify({
        cursor,
        frames: values.length,
        digest: createHash("sha256").update(encoded).digest("hex"),
      }))
    `
    const child = Bun.spawn([process.execPath, "--eval", source], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`yrd: process-fresh journal replay failed (${code}): ${stderr.trim()}`)
    const observed = FreshSummarySchema.parse(JSON.parse(stdout.trim()))
    if (
      observed.cursor !== expected.end ||
      observed.frames !== expected.frames ||
      observed.digest !== expected.digest
    ) {
      throw new Error(
        `yrd: process-fresh replay mismatch (cursor=${observed.cursor}/${expected.end}, frames=${observed.frames}/${expected.frames}, digest=${observed.digest}/${expected.digest})`,
      )
    }
  } finally {
    await rm(verifyDir, { recursive: true, force: true })
  }
}

async function loadManifestRecord(dir: string): Promise<ManifestRecord | null> {
  const path = join(dir, MANIFEST_FILE)
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const manifest = ManifestSchema.parse(parseJson(bytes, path))
  verifySigned(manifest, path)
  validateManifest(manifest)
  return { manifest, bytes }
}

async function loadTailState(dir: string, path: string): Promise<TailState> {
  const absolute = join(dir, path)
  const state = TailStateSchema.parse(parseJson(await readFile(absolute), absolute))
  verifySigned(state, absolute)
  return state
}

async function loadRecovery(dir: string): Promise<Recovery | null> {
  const path = join(dir, RECOVERY_FILE)
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const recovery = RecoverySchema.parse(parseJson(bytes, path))
  verifySigned(recovery, path)
  if ((recovery.previousManifest === null) !== (recovery.previousManifestDigest === null)) {
    throw new Error(`yrd: invalid recovery manifest pair at ${path}`)
  }
  if (
    recovery.previousManifest !== null &&
    sha256(Buffer.from(recovery.previousManifest)) !== recovery.previousManifestDigest
  ) {
    throw new Error(`yrd: recovery manifest checksum mismatch at ${path}`)
  }
  return recovery
}

function createManifest(
  input: Readonly<{
    generation: number
    sourceGeneration: number
    logicalEnd: number
    frames: number
    segments: readonly Segment[]
    tail: z.infer<typeof TailSchema>
    statePath: string
  }>,
): Manifest {
  return ManifestSchema.parse(
    sign({
      formatVersion: FORMAT_VERSION,
      generation: input.generation,
      sourceGeneration: input.sourceGeneration,
      logicalStart: 0,
      logicalEnd: input.logicalEnd,
      frames: input.frames,
      segments: input.segments,
      tail: input.tail,
      tailState: { path: input.statePath },
    }),
  )
}

function createTailState(
  input: Readonly<{
    generation: number
    tailIdentity: string
    committedBytes: number
    logicalEnd: number
    frames: number
    lastChecksum: string | null
  }>,
): TailState {
  return TailStateSchema.parse(sign({ formatVersion: FORMAT_VERSION, ...input }))
}

function createRecovery(
  input: Readonly<{
    kind: "initialize" | "migrate-v3" | "compact"
    fromGeneration: number
    toGeneration: number
    previousManifest: string | null
    sourceV3Path: typeof V3_FILE | null
    rollbackPaths: readonly string[]
    successPaths: readonly string[]
    replay: ReplayExpectation
  }>,
): Recovery {
  return RecoverySchema.parse(
    sign({
      formatVersion: FORMAT_VERSION,
      kind: input.kind,
      fromGeneration: input.fromGeneration,
      toGeneration: input.toGeneration,
      previousManifest: input.previousManifest,
      previousManifestDigest: input.previousManifest === null ? null : sha256(Buffer.from(input.previousManifest)),
      sourceV3Path: input.sourceV3Path,
      rollbackPaths: input.rollbackPaths,
      successPaths: input.successPaths,
      verifyStart: input.replay.start,
      verifyEnd: input.replay.end,
      verifyFrames: input.replay.frames,
      verifyDigest: input.replay.digest,
    }),
  )
}

function validateManifest(manifest: Manifest): void {
  let logicalEnd = 0
  let frames = 0
  for (const segment of manifest.segments) {
    if (segment.logicalStart !== logicalEnd || segment.logicalEnd !== logicalEnd + segment.rawBytes) {
      throw new Error(`yrd: journal manifest has a non-contiguous segment at ${segment.path}`)
    }
    logicalEnd = segment.logicalEnd
    frames += segment.frames
  }
  if (
    manifest.logicalStart !== 0 ||
    manifest.logicalEnd !== logicalEnd ||
    manifest.frames !== frames ||
    manifest.tail.logicalStart !== logicalEnd ||
    manifest.tail.initialSha256 !== EMPTY_DIGEST
  ) {
    throw new Error("yrd: journal manifest ranges or frame counts are inconsistent")
  }
}

function validateActive(manifest: Manifest, state: TailState): void {
  if (
    state.generation !== manifest.generation ||
    state.tailIdentity !== manifest.tail.identity ||
    state.logicalEnd !== manifest.logicalEnd + state.committedBytes ||
    (state.frames === 0) !== (state.lastChecksum === null)
  ) {
    throw new Error("yrd: journal tail state does not match the active manifest")
  }
}

function validateRange(after: number, before: number, size: number): void {
  if (after > before || before > size) {
    throw new RangeError(`yrd: journal range ${after}..${before} is outside 0..${size}`)
  }
}

async function committedExtent(file: FileHandle): Promise<number> {
  const { size } = await file.stat()
  if (size === 0) return 0
  const last = Buffer.allocUnsafe(1)
  await file.read(last, 0, 1, size - 1)
  if (last[0] === 10) return size

  let end = size
  const buffer = Buffer.allocUnsafe(Math.min(SCAN_BYTES, size))
  while (end > 0) {
    const start = Math.max(0, end - buffer.length)
    const { bytesRead } = await file.read(buffer, 0, end - start, start)
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(10)
    if (newline >= 0) return start + newline + 1
    end = start
  }
  return 0
}

async function* decode(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  start: number,
  path: string,
): AsyncIterable<{ cursor: number; values: readonly unknown[] }> {
  let buffer = Buffer.alloc(0)
  let cursor = start
  for await (const chunk of chunks) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
    const newline = buffer.lastIndexOf(10)
    if (newline < 0) continue

    const committed = buffer.subarray(0, newline + 1)
    const parsed = Bun.JSONL.parseChunk(committed)
    if (parsed.error !== null || !parsed.done) {
      throw corrupt(path, cursor + parsed.read, "invalid JSON", parsed.error ?? undefined)
    }

    let values: unknown[]
    try {
      values = parsed.values.map(decodeFrame)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "invalid frame"
      throw corrupt(path, cursor, detail, cause)
    }
    cursor += committed.length
    buffer = buffer.subarray(newline + 1)
    if (values.length > 0) yield { cursor, values }
  }
}

async function decodeValues(raw: Buffer, start: number, path: string): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const batch of decode([raw], start, path)) values.push(...batch.values)
  return values
}

function encode(value: JournalFrame): Readonly<{ bytes: Buffer; checksum: string }> {
  const data = {
    v: VERSION,
    cause: value.cause,
    command: value.command,
    events: value.events,
    ...(value.value === undefined ? {} : { value: value.value }),
  }
  const checksum = digest(data)
  return { bytes: Buffer.from(`${JSON.stringify({ ...data, checksum })}\n`), checksum }
}

function decodeFrame(value: unknown) {
  const stored = StoredFrameSchema.parse(value)
  const { checksum, ...data } = stored
  if (checksum !== digest(data)) throw new Error("yrd: journal frame checksum mismatch")
  return parseFrame({
    cause: stored.cause,
    command: stored.command,
    events: stored.events,
    ...(stored.value === undefined ? {} : { value: stored.value }),
  })
}

function parseFrame(value: unknown): JournalFrame {
  const frame = JournalFrameSchema.parse(value)
  Command.assertCause(frame.command, frame.cause)
  return frame
}

function sign<Value extends Readonly<Record<string, unknown>>>(value: Value): Value & { digest: string } {
  return { ...value, digest: digest(value) }
}

function verifySigned(value: Readonly<Record<string, unknown>> & { digest: string }, path: string): void {
  const { digest: checksum, ...payload } = value
  if (checksum !== digest(payload)) throw new Error(`yrd: metadata checksum mismatch at ${path}`)
}

function digest(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: journal value must be canonical JSON data")
  return createHash("sha256").update(encoded).digest("hex")
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function parseJson(bytes: Buffer, path: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch (cause) {
    throw new Error(`yrd: invalid journal metadata JSON at ${path}`, { cause })
  }
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

async function writeDurableTemp(runtime: Runtime, bytes: Buffer): Promise<string> {
  const path = `events-v4.tmp-${randomUUID()}`
  const absolute = join(runtime.dir, path)
  const file = await open(absolute, "wx")
  try {
    if (bytes.length > 0) await writeAll(file, bytes, 0, runtime.io)
    await runtime.io.datasync(file)
  } catch (error) {
    await file.close().catch(() => undefined)
    await removeIfExists(absolute)
    throw error
  }
  await file.close()
  return path
}

async function replaceDurable(runtime: Runtime, path: string, bytes: Buffer): Promise<void> {
  const temp = await writeDurableTemp(runtime, bytes)
  try {
    await rename(join(runtime.dir, temp), join(runtime.dir, path))
    await syncDirectory(runtime.dir)
  } catch (error) {
    await removeIfExists(join(runtime.dir, temp))
    throw error
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array, position: number, io: JournalIO): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await io.write(file, bytes, offset, bytes.length - offset, position + offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) {
      throw new Error(`yrd: journal write made invalid progress (${bytesWritten} bytes)`)
    }
    offset += bytesWritten
  }
}

async function readExactly(file: FileHandle, position: number, length: number, io: JournalIO): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await io.read(file, bytes, offset, length - offset, position + offset)
    if (bytesRead <= 0) throw new Error(`yrd: journal file ended ${length - offset} bytes early`)
    offset += bytesRead
  }
  return bytes
}

async function readWhole(file: FileHandle, io: JournalIO): Promise<Buffer> {
  const { size } = await file.stat()
  return readExactly(file, 0, size, io)
}

async function closeParts(parts: readonly ReadPart[]): Promise<void> {
  await Promise.all(parts.map((part) => part.file.close()))
}

function partPath(part: ReadPart): string {
  return part.kind === "segment" ? part.descriptor.path : part.path
}

async function removePaths(runtime: Runtime, paths: readonly string[]): Promise<void> {
  for (const path of paths) await removeIfExists(join(runtime.dir, path))
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function threshold(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`yrd: journal ${name} threshold must be a positive safe integer`)
  }
  return result
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("yrd: journal cursor must be a non-negative safe integer")
  }
}

function corrupt(path: string, cursor: number, detail: string, cause?: unknown): Error {
  return new Error(`yrd: journal corrupt at ${path}:${cursor} - ${detail}`, cause === undefined ? {} : { cause })
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
