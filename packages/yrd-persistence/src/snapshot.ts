/**
 * Journal replay snapshot cache — file format and validation.
 *
 * The snapshot is a pure cache of decoded v4 journal frames covering the logical
 * range [0, cursor). The journal stays the sole source of truth: a reader that
 * does not know about the snapshot is unaffected, and every consumer still folds
 * each frame through its own projection (receipts, dedup sets, and state are
 * rebuilt from the cached frames exactly as from a raw replay).
 *
 * Integrity model:
 * - `digest` (canonical sha256 of the header) rejects any tampered/corrupt header.
 * - `valuesSha256` (sha256 of the JSON-serialized values array) rejects any
 *   tampered/corrupt/truncated values payload without per-frame re-validation.
 * - `binding` ties the snapshot to one exact journal generation (generation,
 *   manifest digest, tail identity, segment offsets) plus a checksum of the
 *   covered tail prefix, so covered journal bytes that change on disk are always
 *   detected — the cache can never mask corruption a raw replay would surface.
 *
 * Any mismatch is reported to the caller, which MUST warn loudly and fall back
 * to a full replay followed by an atomic rewrite. Never fall back silently.
 */
import { createHash } from "node:crypto"
import canonicalize from "canonicalize"
import * as z from "zod"

export const SNAPSHOT_FILE = "snapshot-v4.json"
export const PROJECTION_CHECKPOINT_FILE = "projection-checkpoint-v1.json"
export const SNAPSHOT_SCHEMA_VERSION = 1
export const CORE_CHECKPOINT_SCHEMA_VERSION = 1
/** Rewrite the snapshot only once this many frames were replayed beyond it. */
export const SNAPSHOT_REFRESH_FRAMES = 200

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const IntegerSchema = z.number().int().nonnegative()

const SnapshotSegmentSchema = z
  .object({
    path: z.string().min(1),
    logicalStart: IntegerSchema,
    logicalEnd: IntegerSchema,
    compressedSha256: DigestSchema,
  })
  .strict()

const SnapshotBindingSchema = z
  .object({
    formatVersion: z.literal(4),
    /**
     * Identity of the decoder that produced the cached values. Cached frames are
     * served without per-frame re-validation, so any change to frame decoding or
     * validation semantics MUST change this string (see JOURNAL_DECODER in
     * journal.ts) — a mismatch invalidates the cache loudly instead of silently
     * serving stale-shaped values.
     */
    decoder: z.string().min(1),
    generation: IntegerSchema,
    manifestDigest: DigestSchema,
    tailIdentity: z.string().uuid(),
    tailLogicalStart: IntegerSchema,
    tailPrefixSha256: DigestSchema,
    segments: z.array(SnapshotSegmentSchema),
  })
  .strict()

const CoreCheckpointHeaderSchema = z
  .object({
    v: z.literal(CORE_CHECKPOINT_SCHEMA_VERSION),
    identity: z.string().min(1),
    cursor: IntegerSchema,
    valueSha256: DigestSchema,
  })
  .strict()

const SnapshotHeaderPayloadSchema = z
  .object({
    v: z.literal(SNAPSHOT_SCHEMA_VERSION),
    binding: SnapshotBindingSchema,
    cursor: IntegerSchema,
    frames: IntegerSchema,
    valuesSha256: DigestSchema,
    checkpoint: CoreCheckpointHeaderSchema.optional(),
  })
  .strict()

const SnapshotFileSchema = SnapshotHeaderPayloadSchema.extend({
  digest: DigestSchema,
  values: z.array(z.unknown()),
  checkpointValue: z.unknown().optional(),
}).strict()

const ProjectionCheckpointFileSchema = z
  .object({
    v: z.literal(CORE_CHECKPOINT_SCHEMA_VERSION),
    binding: SnapshotBindingSchema,
    cursor: IntegerSchema,
    checkpoint: CoreCheckpointHeaderSchema,
    digest: DigestSchema,
    checkpointValue: z.unknown(),
  })
  .strict()

/** The journal identity a snapshot must match, derived from the active manifest + tail state. */
export type SnapshotBindingView = Readonly<{
  decoder: string
  generation: number
  manifestDigest: string
  tailIdentity: string
  tailLogicalStart: number
  logicalEnd: number
  segments: readonly Readonly<{
    path: string
    logicalStart: number
    logicalEnd: number
    compressedSha256: string
  }>[]
}>

export type SnapshotCheckpoint = Readonly<{
  identity: string
  cursor: number
  value: unknown
}>

export type SnapshotParseResult =
  | Readonly<{
      ok: true
      cursor: number
      frames: number
      values: readonly unknown[]
      valuesJson: string
      tailPrefixSha256: string
      checkpoint?: SnapshotCheckpoint
    }>
  | Readonly<{ ok: false; reason: string; expected?: unknown; observed?: unknown }>

export type ProjectionCheckpointParseResult =
  | Readonly<{
      ok: true
      checkpoint: SnapshotCheckpoint
      tailPrefixSha256: string
    }>
  | Readonly<{ ok: false; reason: string; expected?: unknown; observed?: unknown }>

export function parseSnapshotFile(text: string, view: SnapshotBindingView): SnapshotParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return {
      ok: false,
      reason: "snapshot-corrupt-json",
      observed: cause instanceof Error ? cause.message : String(cause),
    }
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "snapshot-envelope-invalid", observed: typeof raw }
  }
  const version = (raw as { v?: unknown }).v
  if (version !== SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, reason: "snapshot-schema-version", expected: SNAPSHOT_SCHEMA_VERSION, observed: version }
  }
  const parsed = SnapshotFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: "snapshot-envelope-invalid", observed: parsed.error.message }
  }
  const { digest: checksum, values, checkpointValue, ...payload } = parsed.data
  const expectedChecksum = digestOf(payload)
  if (checksum !== expectedChecksum) {
    return { ok: false, reason: "snapshot-header-checksum", expected: expectedChecksum, observed: checksum }
  }
  const valuesJson = JSON.stringify(values)
  const valuesSha256 = sha256Utf8(valuesJson)
  if (valuesSha256 !== payload.valuesSha256) {
    return { ok: false, reason: "snapshot-values-checksum", expected: payload.valuesSha256, observed: valuesSha256 }
  }
  if (values.length !== payload.frames) {
    return { ok: false, reason: "snapshot-frame-count", expected: payload.frames, observed: values.length }
  }
  const hasCheckpointValue = Object.hasOwn(parsed.data, "checkpointValue")
  if ((payload.checkpoint === undefined) !== !hasCheckpointValue) {
    return { ok: false, reason: "snapshot-checkpoint-envelope" }
  }
  let checkpoint: SnapshotCheckpoint | undefined
  if (payload.checkpoint !== undefined) {
    const checkpointJson = JSON.stringify(checkpointValue)
    if (checkpointJson === undefined) return { ok: false, reason: "snapshot-checkpoint-json" }
    const observed = sha256Utf8(checkpointJson)
    if (observed !== payload.checkpoint.valueSha256) {
      return {
        ok: false,
        reason: "snapshot-checkpoint-checksum",
        expected: payload.checkpoint.valueSha256,
        observed,
      }
    }
    if (payload.checkpoint.cursor > payload.cursor) {
      return {
        ok: false,
        reason: "snapshot-checkpoint-ahead",
        expected: `<= ${payload.cursor}`,
        observed: payload.checkpoint.cursor,
      }
    }
    checkpoint = {
      identity: payload.checkpoint.identity,
      cursor: payload.checkpoint.cursor,
      value: checkpointValue,
    }
  }
  const binding = payload.binding
  if (binding.decoder !== view.decoder) {
    return { ok: false, reason: "snapshot-decoder-mismatch", expected: view.decoder, observed: binding.decoder }
  }
  if (binding.generation !== view.generation) {
    return {
      ok: false,
      reason: "snapshot-generation-mismatch",
      expected: view.generation,
      observed: binding.generation,
    }
  }
  if (binding.tailIdentity !== view.tailIdentity) {
    return {
      ok: false,
      reason: "snapshot-tail-identity-mismatch",
      expected: view.tailIdentity,
      observed: binding.tailIdentity,
    }
  }
  if (binding.manifestDigest !== view.manifestDigest) {
    return {
      ok: false,
      reason: "snapshot-manifest-mismatch",
      expected: view.manifestDigest,
      observed: binding.manifestDigest,
    }
  }
  if (binding.tailLogicalStart !== view.tailLogicalStart) {
    return {
      ok: false,
      reason: "snapshot-tail-start-mismatch",
      expected: view.tailLogicalStart,
      observed: binding.tailLogicalStart,
    }
  }
  if (!segmentsMatch(binding.segments, view.segments)) {
    return {
      ok: false,
      reason: "snapshot-segments-mismatch",
      expected: view.segments,
      observed: binding.segments,
    }
  }
  if (payload.cursor < binding.tailLogicalStart) {
    // A cursor inside the segment range would leave a partially covered segment
    // outside physical verification, letting a repeated bounded read serve cached
    // frames over corrupted covered bytes. Snapshots may only end at or beyond the
    // tail start (all segments fully covered), so reject anything else loudly —
    // including files seeded by pre-fix builds.
    return {
      ok: false,
      reason: "snapshot-covers-partial-segment",
      expected: `>= ${binding.tailLogicalStart}`,
      observed: payload.cursor,
    }
  }
  if (payload.cursor > view.logicalEnd) {
    return {
      ok: false,
      reason: "snapshot-ahead-of-journal",
      expected: `<= ${view.logicalEnd}`,
      observed: payload.cursor,
    }
  }
  return {
    ok: true,
    cursor: payload.cursor,
    frames: payload.frames,
    values,
    valuesJson,
    tailPrefixSha256: binding.tailPrefixSha256,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  }
}

export function encodeSnapshotFile(
  input: Readonly<{
    view: SnapshotBindingView
    cursor: number
    frames: number
    valuesJson: string
    tailPrefixSha256: string
    checkpoint?: SnapshotCheckpoint
  }>,
): string {
  const binding = SnapshotBindingSchema.parse({
    formatVersion: 4,
    decoder: input.view.decoder,
    generation: input.view.generation,
    manifestDigest: input.view.manifestDigest,
    tailIdentity: input.view.tailIdentity,
    tailLogicalStart: input.view.tailLogicalStart,
    tailPrefixSha256: input.tailPrefixSha256,
    segments: input.view.segments.map((segment) => ({
      path: segment.path,
      logicalStart: segment.logicalStart,
      logicalEnd: segment.logicalEnd,
      compressedSha256: segment.compressedSha256,
    })),
  })
  let checkpointJson: string | undefined
  const checkpoint =
    input.checkpoint === undefined
      ? undefined
      : (() => {
          checkpointJson = JSON.stringify(input.checkpoint.value)
          if (checkpointJson === undefined) throw new TypeError("yrd: snapshot checkpoint must be JSON data")
          return CoreCheckpointHeaderSchema.parse({
            v: CORE_CHECKPOINT_SCHEMA_VERSION,
            identity: input.checkpoint.identity,
            cursor: input.checkpoint.cursor,
            valueSha256: sha256Utf8(checkpointJson),
          })
        })()
  const payload = SnapshotHeaderPayloadSchema.parse({
    v: SNAPSHOT_SCHEMA_VERSION,
    binding,
    cursor: input.cursor,
    frames: input.frames,
    valuesSha256: sha256Utf8(input.valuesJson),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  })
  const header = JSON.stringify({ ...payload, digest: digestOf(payload) })
  // Splice the pre-serialized values in so large payloads are stringified exactly once.
  return `${header.slice(0, -1)},"values":${input.valuesJson}${checkpointJson === undefined ? "" : `,"checkpointValue":${checkpointJson}`}}\n`
}

export function parseProjectionCheckpointFile(
  text: string,
  view: SnapshotBindingView,
): ProjectionCheckpointParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return {
      ok: false,
      reason: "checkpoint-corrupt-json",
      observed: cause instanceof Error ? cause.message : String(cause),
    }
  }
  const parsed = ProjectionCheckpointFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: "checkpoint-envelope-invalid", observed: parsed.error.message }
  }
  const { digest: checksum, checkpointValue, ...payload } = parsed.data
  const expectedChecksum = digestOf(payload)
  if (checksum !== expectedChecksum) {
    return { ok: false, reason: "checkpoint-header-checksum", expected: expectedChecksum, observed: checksum }
  }
  const valueJson = JSON.stringify(checkpointValue)
  if (valueJson === undefined) return { ok: false, reason: "checkpoint-value-json" }
  const valueSha256 = sha256Utf8(valueJson)
  if (valueSha256 !== payload.checkpoint.valueSha256) {
    return {
      ok: false,
      reason: "checkpoint-value-checksum",
      expected: payload.checkpoint.valueSha256,
      observed: valueSha256,
    }
  }
  if (payload.checkpoint.cursor !== payload.cursor) {
    return {
      ok: false,
      reason: "checkpoint-cursor-mismatch",
      expected: payload.cursor,
      observed: payload.checkpoint.cursor,
    }
  }
  const bindingFailure = validateBinding(payload.binding, payload.cursor, view, "checkpoint")
  if (bindingFailure !== undefined) return bindingFailure
  return {
    ok: true,
    checkpoint: {
      identity: payload.checkpoint.identity,
      cursor: payload.checkpoint.cursor,
      value: checkpointValue,
    },
    tailPrefixSha256: payload.binding.tailPrefixSha256,
  }
}

export function encodeProjectionCheckpointFile(
  input: Readonly<{
    view: SnapshotBindingView
    cursor: number
    tailPrefixSha256: string
    checkpoint: SnapshotCheckpoint
  }>,
): string {
  const checkpointValue = JSON.stringify(input.checkpoint.value)
  if (checkpointValue === undefined) throw new TypeError("yrd: projection checkpoint must be JSON data")
  const binding = SnapshotBindingSchema.parse({
    formatVersion: 4,
    decoder: input.view.decoder,
    generation: input.view.generation,
    manifestDigest: input.view.manifestDigest,
    tailIdentity: input.view.tailIdentity,
    tailLogicalStart: input.view.tailLogicalStart,
    tailPrefixSha256: input.tailPrefixSha256,
    segments: input.view.segments,
  })
  const checkpoint = CoreCheckpointHeaderSchema.parse({
    v: CORE_CHECKPOINT_SCHEMA_VERSION,
    identity: input.checkpoint.identity,
    cursor: input.checkpoint.cursor,
    valueSha256: sha256Utf8(checkpointValue),
  })
  const payload = {
    v: CORE_CHECKPOINT_SCHEMA_VERSION as const,
    binding,
    cursor: input.cursor,
    checkpoint,
  }
  const header = JSON.stringify({ ...payload, digest: digestOf(payload) })
  return `${header.slice(0, -1)},"checkpointValue":${checkpointValue}}\n`
}

/** Extend a serialized values array ("[...]") with additional pre-serialized values. */
export function joinValuesJson(base: string, chunks: readonly string[]): string {
  if (chunks.length === 0) return base
  const joined = chunks.join(",")
  return base === "[]" ? `[${joined}]` : `${base.slice(0, -1)},${joined}]`
}

function segmentsMatch(
  observed: readonly z.infer<typeof SnapshotSegmentSchema>[],
  expected: SnapshotBindingView["segments"],
): boolean {
  if (observed.length !== expected.length) return false
  return observed.every((segment, index) => {
    const other = expected[index]
    return (
      other !== undefined &&
      segment.path === other.path &&
      segment.logicalStart === other.logicalStart &&
      segment.logicalEnd === other.logicalEnd &&
      segment.compressedSha256 === other.compressedSha256
    )
  })
}

function validateBinding(
  binding: z.infer<typeof SnapshotBindingSchema>,
  cursor: number,
  view: SnapshotBindingView,
  prefix: string,
): Readonly<{ ok: false; reason: string; expected?: unknown; observed?: unknown }> | undefined {
  if (binding.decoder !== view.decoder) {
    return { ok: false, reason: `${prefix}-decoder-mismatch`, expected: view.decoder, observed: binding.decoder }
  }
  if (binding.generation !== view.generation) {
    return {
      ok: false,
      reason: `${prefix}-generation-mismatch`,
      expected: view.generation,
      observed: binding.generation,
    }
  }
  if (binding.tailIdentity !== view.tailIdentity) {
    return {
      ok: false,
      reason: `${prefix}-tail-identity-mismatch`,
      expected: view.tailIdentity,
      observed: binding.tailIdentity,
    }
  }
  if (binding.manifestDigest !== view.manifestDigest) {
    return {
      ok: false,
      reason: `${prefix}-manifest-mismatch`,
      expected: view.manifestDigest,
      observed: binding.manifestDigest,
    }
  }
  if (binding.tailLogicalStart !== view.tailLogicalStart) {
    return {
      ok: false,
      reason: `${prefix}-tail-start-mismatch`,
      expected: view.tailLogicalStart,
      observed: binding.tailLogicalStart,
    }
  }
  if (!segmentsMatch(binding.segments, view.segments)) {
    return {
      ok: false,
      reason: `${prefix}-segments-mismatch`,
      expected: view.segments,
      observed: binding.segments,
    }
  }
  if (cursor < binding.tailLogicalStart) {
    return {
      ok: false,
      reason: `${prefix}-covers-partial-segment`,
      expected: `>= ${binding.tailLogicalStart}`,
      observed: cursor,
    }
  }
  if (cursor > view.logicalEnd) {
    return {
      ok: false,
      reason: `${prefix}-ahead-of-journal`,
      expected: `<= ${view.logicalEnd}`,
      observed: cursor,
    }
  }
  return undefined
}

function digestOf(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: snapshot header must be canonical JSON data")
  return createHash("sha256").update(encoded).digest("hex")
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
