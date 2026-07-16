# `@yrd/persistence`

`@yrd/persistence` implements Core's `Journal` over repository-local durable
files. It owns logical byte cursors, checksums, torn-tail repair, POSIX writer
exclusion, exact archive segments, data sync, and directory sync. It does not
own commands, projections, retention policy, or Core cursor semantics.

```ts
import { createJournal } from "@yrd/persistence"

const journal = createJournal({ dir: ".git/yrd" })
```

The synchronous factory returns the same plain two-method Core object:

```ts
journal.read(afterCursor)
journal.append(transaction, expectedCursor)
```

Core cursors remain opaque. Persistence alone interprets its cursor as a logical
byte boundary across immutable segments and the active tail. Every committed
cursor remains valid across compaction and process restart.

## Formats and migration

A repository may begin with strict `events-v3.jsonl`: one checksummed versioned
transaction per line. An unterminated final record is uncommitted; readers ignore
it and the next mutation repairs it under the writer lock. A malformed
newline-terminated record is committed corruption and aborts replay.

The first successful mutation migrates v3 into private format v4. Read-only
access never migrates. `events-v4.manifest.json` names one generation, immutable
content-addressed gzip segments, a generation-unique JSONL tail, and the tail's
durable state pointer. Segment metadata carries logical ranges, frame counts,
source generation and tail identity, codec/version/parameters, and SHA-256 for
both exact raw JSONL and compressed bytes.

The original v3 file is the recovery authority until the candidate v4 generation
passes replay through a fresh Bun process using the production Journal decoder.
The retention policy is explicit: remove v3 only after that verified success;
on verification failure restore v3 authority and preserve failed manifest,
recovery pointer, and candidate files as operator evidence.

An operator may explicitly preserve a detached v3 lane with
`yrd journal import-orphan <path>`. The source stays read-only. Each source row
is appended atomically as a checksummed `archived-orphan` v4 record containing
the original stored frame plus `origin-lane`, `origin-file`, `origin-row`,
`source-sha256`, `imported-at`, `imported-by`, and `collision-policy=refuse`
provenance. Core
`Journal.read()` advances its opaque cursor across these physical records but
never returns them as live frames; audit consumers use
`readArchivedOrphans()` instead. Import refuses before mutation when a command,
cause, event, or canonical payload identity already exists live, and replaying
the same origin rows is idempotent.

## Append durability

Append remains compare-and-append under the existing POSIX writer lock:

1. recover or refuse any interrupted generation;
2. compare the durable logical cursor;
3. append one checksummed frame to the active tail and `datasync` it;
4. write and `datasync` a temporary tail-state record;
5. rename it over the tail-state pointer and sync the directory;
6. return the cursor only after the state pointer is durable.

This is roughly three times v3's sync count per append. Coordination event rates
make that acceptable; do not optimize it by weakening the commit record. Bytes
past the durable tail-state extent were never acknowledged. Recovery truncates
them and reports `action=recovered reason=uncommitted-tail` before replay or a
later append.

A stale cursor returns `{ appended: false, cursor }`. Readers acquire one
generation snapshot under the writer lock, pin every segment and tail descriptor,
then release the lock before streaming. POSIX open-inode semantics let a paused
reader finish its old snapshot while compaction installs and cleans a new one.

## Compaction

The committed active tail rotates before an append when either inclusive
threshold was already reached:

- tail bytes at least 10 MiB; or
- tail frames at least 10,000.

The append that crosses a threshold commits normally. The following append
seals that exact tail into one deterministic gzip segment, creates a fresh tail,
and only then appends. Existing segments are referenced byte-for-byte; ordinary
compaction never reads, rewrites, or deletes them. GC means only unreferenced
temporaries, verified recovery pointers, and superseded mutable tail/state
files. No event, receipt, command, cause, or immutable archive segment is
discarded because Yrd has no destructive retention watermark.

Candidate compression may run outside the writer lock from a pinned committed
prefix. Installation reacquires the lock and compares generation, logical end,
tail identity, and tail-state digest. Any mismatch removes only the unreferenced
candidate and reports `action=refused reason=concurrent-generation-or-writer`
with zero authoritative mutation.

The durable install order is new unreferenced files, recovery pointer, manifest
pointer rename, directory sync, process-fresh production replay, then cleanup.
An interruption before the manifest switch keeps the old generation. An
interruption after it re-verifies the new generation. Verification failure
atomically restores the previous authority and preserves evidence. All
migration and compaction mutation is POSIX-only; Windows refuses before creating
a lock, temporary, backup, segment, tail, state, or manifest file.

## Operator evidence and cold replay

Threshold, compaction, refusal, and recovery logs use stable fields including
`bytes`, `frames`, `tailBytes`, `tailFrames`, `thresholdBytes`,
`thresholdFrames`, `action`, `reason`, generations, logical ends, paths,
digests, codec/version, and operation counts. Thresholds are policy constants,
not runtime tuning knobs.

Compaction bounds command-time sealing work to the active tail and reports zero
prior-segment bytes read or rewritten. It intentionally retains exact history,
so a fresh process and `events()` still decode O(retained frames). Cold replay at
or above the guardrail reports its measured duration and does not claim to be
bounded. A separate versioned projection-checkpoint design becomes eligible
only when fleet-bay cold replay exceeds about 250 ms p50 or retained history
exceeds 100,000 frames; do not hide that public decision inside persistence.
