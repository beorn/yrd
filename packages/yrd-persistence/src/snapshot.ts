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
export const SNAPSHOT_SCHEMA_VERSION = 1
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

const SnapshotHeaderPayloadSchema = z
  .object({
    v: z.literal(SNAPSHOT_SCHEMA_VERSION),
    binding: SnapshotBindingSchema,
    cursor: IntegerSchema,
    frames: IntegerSchema,
    valuesSha256: DigestSchema,
  })
  .strict()

const SnapshotFileSchema = SnapshotHeaderPayloadSchema.extend({
  digest: DigestSchema,
  values: z.array(z.unknown()),
}).strict()

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

export type SnapshotParseResult =
  | Readonly<{
      ok: true
      cursor: number
      frames: number
      values: readonly unknown[]
      valuesJson: string
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
  const { digest: checksum, values, ...payload } = parsed.data
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
  }
}

export function encodeSnapshotFile(
  input: Readonly<{
    view: SnapshotBindingView
    cursor: number
    frames: number
    valuesJson: string
    tailPrefixSha256: string
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
  const payload = SnapshotHeaderPayloadSchema.parse({
    v: SNAPSHOT_SCHEMA_VERSION,
    binding,
    cursor: input.cursor,
    frames: input.frames,
    valuesSha256: sha256Utf8(input.valuesJson),
  })
  const header = JSON.stringify({ ...payload, digest: digestOf(payload) })
  // Splice the pre-serialized values in so large payloads are stringified exactly once.
  return `${header.slice(0, -1)},"values":${input.valuesJson}}\n`
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

function digestOf(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: snapshot header must be canonical JSON data")
  return createHash("sha256").update(encoded).digest("hex")
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
