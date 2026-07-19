# `@yrd/persistence`

`@yrd/persistence` implements Core's event-sourced `Journal` in one
repository-local SQLite authority. It owns opaque cursor ordering, checksums,
compare-and-append transactions, snapshot publication, migration, and the
short cross-process writer lock; commands and projections remain Core concerns.

```ts
import { createJournal } from "@yrd/persistence"

const journal = createJournal({ dir: ".git/yrd" })

for await (const batch of journal.read(afterCursor)) {
  // batch.cursor is an opaque committed boundary
}
await journal.append(frame, expectedCursor)
```

The synchronous factory is lazy. A fresh mutable journal creates
`journal.sqlite` on its first operation; a read-only journal never creates,
migrates, checkpoints, or appends authority.

## SQLite authority

`journal.sqlite` is the only live authority after publication. Its strict
schema contains:

- `journal_events`, the cursor-ordered append tail with SHA-256 bound to the
  exact stored JSON bytes;
- one `journal_snapshot` row with an exact cursor-addressable prefix and an
  independently checked Core projection checkpoint;
- `journal_orphans`, detached audit frames that never enter Core replay; and
- schema, head-cursor, migration-completion, and source-fingerprint metadata.

Fresh SQL cursors begin at `1`. Migration preserves every committed legacy
byte cursor exactly, then allocates the next SQL cursor as `head + 1`. Cursors
are opaque safe integers and the sole row order—callers must never infer byte
offsets or density from them.

Append is a `BEGIN IMMEDIATE` compare-and-append transaction under
`writer.lock`. It compares the durable head, inserts one checksummed frame,
updates the head metadata, and commits with `synchronous=FULL`. A stale cursor
returns `{ appended: false, cursor }`; Core replays and repeats its pure command
decision. Every mutable connection is explicitly checkpointed and closed while
the external lock is held.

SQLite WAL is refused at runtime on affected builds. Yrd accepts SQLite
`>=3.51.3` and the official `3.50.7` / `3.44.6` fixed backports; the gate uses
the value returned by `sqlite_version()`, not a Bun package-version assumption.
Mutation remains POSIX-only. Windows refuses before creating or migrating
authority.

## Snapshot and replay

Core supplies a projection checkpoint after startup and periodically while a
writer remains alive. The first threshold coalesces a background save after
256 projected frames; a 512-frame high-water blocks additional mutable work
until the save catches up. Close drains in-flight work and performs a final
save.

Snapshot publication is one SQL transaction: extend the cursor-addressable
prefix, bind the Core checkpoint to the same cursor, then delete covered rows
from `journal_events`. `read(after, before)` joins the exact prefix and remaining
tail, so old notification cursors and legacy byte boundaries remain valid after
SQL deletion. A stale runtime cannot lower the snapshot cursor.

Mutable journals expose checkpoint `load` and `save`; read-only journals expose
`load` only. Read-only access leaves DB, WAL, schema, and rows unchanged.
SQLite may create or update the volatile `-shm` coordination file while a live
WAL database is open; immutable media therefore requires a closed/checkpointed
database or a separately proven immutable-open path.

## Legacy migration and recovery

The first mutable operation imports strict `events-v3.jsonl` or the active
checksummed v4 manifest/segments/tail. Read-only access reports that migration
is required. Migration:

1. validates signed v4 ranges, frame counts, identities, codecs, and exact
   compressed/raw checksums;
2. creates a same-directory rollback-journal candidate with
   `synchronous=FULL`;
3. verifies integrity and exact replay/orphan/cursor equivalence through the
   production read path in a fresh Bun process;
4. preserves a durable `journal-v4-pre-sqlite-<fingerprint>` recovery copy;
5. atomically retires the old writer pointer with a signed, candidate-bound
   pre-publication marker;
6. fsyncs the closed candidate and directory, atomically renames it to
   `journal.sqlite`, publishes the irrevocable marker, fsyncs again, and only
   then enables WAL.

A hard interruption after writer retirement completes the already verified,
fingerprint-bound candidate on restart; a handled pre-rename failure restores
the preserved pointer. Once a complete SQLite candidate is renamed, cutover is
irrevocable: corruption, a mismatched fingerprint, a missing database, or an
incomplete schema fails loud and Yrd never resurrects stale JSONL. The
preserved legacy files are operator recovery evidence, not a fallback lane.

## Detached orphan audit

`yrd journal import-orphan <path>` imports a detached v3 lane into
`journal_orphans` with its source hash, origin row, importer, timestamp, and
collision policy. Import refuses atomically when a command, cause, event, or
canonical payload identity already exists live. Repeating the same complete
source is idempotent; a partial or payload-mismatched import fails loud.

Core `Journal.read()` advances across orphan cursor markers but never returns
orphan frames. Audit consumers use `readArchivedOrphans()`.
