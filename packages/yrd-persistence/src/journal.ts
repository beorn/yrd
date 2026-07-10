import { createHash } from "node:crypto"
import { open, stat, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { CauseSchema, EventSchema, Frame, type Journal } from "@yrd/core"
import canonicalize from "canonicalize"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"
import { createExclusive, type Exclusive, type ExclusiveOptions } from "./lock.ts"

const VERSION = 1
const SCAN_BYTES = 64 * 1024
const WARN_BYTES = 10 * 1024 * 1024
const WARN_FRAMES = 10_000

type JournalIO = Readonly<{
  write(
    file: FileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesWritten: number }>>
  datasync(file: FileHandle): Promise<void>
}>

const defaultIO: JournalIO = {
  write: (file, bytes, offset, length, position) => file.write(bytes, offset, length, position),
  datasync: (file) => file.datasync(),
}

const StoredFrameSchema = z
  .object({
    v: z.literal(VERSION),
    cause: CauseSchema,
    events: z.array(EventSchema),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export function createJournal(
  options: Readonly<{
    dir: string
    lock?: ExclusiveOptions
    inject?: Readonly<{
      exclusive?: Exclusive
      io?: Partial<JournalIO>
      log?: ConditionalLogger
    }>
  }>,
): Journal<unknown> {
  const path = join(options.dir, "events.jsonl")
  const exclusive = options.inject?.exclusive ?? createExclusive(options.dir, options.lock)
  const io: JournalIO = { ...defaultIO, ...options.inject?.io }
  const log = options.inject?.log?.child("journal") ?? createLogger("yrd:journal")

  return {
    async *read(after = 0, before) {
      assertCursor(after)
      if (before !== undefined) assertCursor(before)

      const size = await exclusive.run(async () => {
        try {
          return (await stat(path)).size
        } catch (error) {
          if (isMissing(error)) return null
          throw error
        }
      })
      if (size === null) return
      const end = before ?? size
      if (after > end || end > size) throw new RangeError(`yrd: journal range ${after}..${end} is outside 0..${size}`)
      if (after === end) return

      using span = log.span?.("read", { after, before: end, size })
      void span
      let frames = 0
      for await (const batch of decode(Bun.file(path).slice(after, end).stream(), after, path)) {
        frames += batch.values.length
        yield batch
      }
      if (size >= WARN_BYTES || (after === 0 && frames >= WARN_FRAMES)) {
        log.warn?.("journal replay exceeded the compaction guardrail", {
          bytes: size,
          frames,
          warnBytes: WARN_BYTES,
          warnFrames: WARN_FRAMES,
          action: "Implement @yrd/core/21012-monorepo/21060-journal-compaction-gc before increasing these limits.",
        })
      }
    },

    append(value, expectedCursor) {
      assertCursor(expectedCursor)
      const frame = Frame.parse(value)
      return exclusive.run(async () => {
        const { file, created } = await openJournal(path)
        let committed = 0
        try {
          committed = await repairTail(file, io)
          if (committed !== expectedCursor) return { appended: false as const, cursor: committed }

          const bytes = encode(frame)
          try {
            await writeAll(file, bytes, committed, io)
            await io.datasync(file)
          } catch (error) {
            await file.truncate(committed)
            await file.datasync()
            throw error
          }
          if (created) await syncDirectory(options.dir)
          return { appended: true as const, cursor: committed + bytes.length }
        } finally {
          await file.close()
        }
      })
    },
  }
}

async function* decode(
  chunks: AsyncIterable<Uint8Array>,
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

function encode(value: ReturnType<typeof Frame.parse>): Buffer {
  const data = { v: VERSION, cause: value.cause, events: value.events }
  return Buffer.from(`${JSON.stringify({ ...data, checksum: digest(data) })}\n`)
}

function decodeFrame(value: unknown) {
  const stored = StoredFrameSchema.parse(value)
  const { checksum, ...data } = stored
  if (checksum !== digest(data)) throw new Error("yrd: journal frame checksum mismatch")
  return Frame.parse({ cause: stored.cause, events: stored.events })
}

function digest(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: journal frame must be canonical JSON data")
  return createHash("sha256").update(encoded).digest("hex")
}

async function openJournal(path: string) {
  try {
    return { file: await open(path, "r+"), created: false }
  } catch (error) {
    if (!isMissing(error)) throw error
    return { file: await open(path, "w+"), created: true }
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

async function repairTail(file: FileHandle, io: JournalIO) {
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
    if (newline >= 0) {
      const committed = start + newline + 1
      await file.truncate(committed)
      await io.datasync(file)
      return committed
    }
    end = start
  }
  await file.truncate(0)
  await io.datasync(file)
  return 0
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
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
