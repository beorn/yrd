# git bay batches — executable spec

Batching is automatic when `bay.queue.batch-size` is greater than one: `git bay integrate` composes compatible submitted PRs into a batch candidate, lands that candidate through the pipeline (check, then the merge command), and records the batch in the journal-backed status output. A configured check runs against the tree it judges: a bayless PR — including every batch candidate — gets a scratch workspace at its own target, never the mainline working tree. When the candidate lands, each member's outcome becomes journal truth: a `pr/changed` → merged per member (its compose-time tip as `sha`) plus one `batch/settled` summary. These specs rest submitted PRs with `bay.autoMerge false` so a queue can form; with the default auto-flow each submit would land individually before a batch could compose.

## Happy batch

```console
$ git init -q batch-happy && cd batch-happy && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git config bay.queue.batch-size 2
$ git config bay.autoMerge false
$ git config bay.mergeCommand 'git -c user.name=t -c user.email=t@example.invalid merge --no-ff -q {target}'
$ git switch -qc task/a main && echo a > a.txt && git add a.txt && git commit -qm a && git switch -q main
$ git switch -qc task/b main && echo b > b.txt && git add b.txt && git commit -qm b && git switch -q main
$ git bay adopt task/a
PR1
$ git bay adopt task/b
PR2
$ git bay submit PR1
bay: PR1 submitted — git bay integrate PR1 to land it
$ git bay submit PR2
bay: PR2 submitted — git bay integrate PR2 to land it
$ git bay integrate
bay: batch PR3 composed — members: PR1, PR2
bay: batch PR3 built — members: PR1, PR2
bay: PR3 submitted → checking
bay: PR3 checking → checked
bay: PR3 checked → merging
bay: PR3 merging → merged
bay: PR1 checking → merged — merged via batch PR3 (candidate {{happy_a:/.*$/}}
bay: PR2 checking → merged — merged via batch PR3 (candidate {{happy_b:/.*$/}}
$ git bay ls PR3
PR3 merged (checks: ✓)
batch PR3 merged — members: PR1, PR2
$ cd ..
```

## Build-conflict ejection

```console
$ git init -q batch-conflict && cd batch-conflict && git commit -qm init --allow-empty
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git config bay.queue.batch-size 2
$ git config bay.autoMerge false
$ git config bay.mergeCommand 'git -c user.name=t -c user.email=t@example.invalid merge --no-ff -q {target}'
$ git switch -qc task/file main && echo file > dir && git add dir && git commit -qm file && git switch -q main
$ git switch -qc task/nested main && mkdir -p dir && echo nested > dir/file.txt && git add dir/file.txt && git commit -qm nested && git switch -q main
$ git bay adopt task/file
PR1
$ git bay adopt task/nested
PR2
$ git bay submit PR1
bay: PR1 submitted — git bay integrate PR1 to land it
$ git bay submit PR2
bay: PR2 submitted — git bay integrate PR2 to land it
$ git bay integrate
bay: batch PR3 composed — members: PR1, PR2
bay: PR2 ejected from batch PR3 — scratch merge of task/nested failed. Rebuilding batch without it; remainder will land. Fix and retry: git bay retry PR2.{{conflict_detail:/.*$/}}
bay: batch PR3 built — members: PR1; ejected: PR2
bay: PR3 submitted → checking
bay: PR3 checking → checked
bay: PR3 checked → merging
bay: PR3 merging → merged
bay: PR1 checking → merged — merged via batch PR3 (candidate {{conflict_settled:/.*$/}}
$ git bay ls PR2
PR2 rejected — bay: PR2 ejected from batch PR3 — scratch merge of task/nested failed. Rebuilding batch without it; remainder will land. Fix and retry: git bay retry PR2.{{conflict_status_detail:/.*$/}}
$ cd ..
```

## Red batch-gate ejection

```console
$ git init -q batch-red && cd batch-red && git commit -qm init --allow-empty
$ cat > merge-if-clean.sh <<'SH'
> #!/bin/sh
> target="$1"
> if git cat-file -e "$target:bad.txt" 2>/dev/null; then
>   echo "bad batch" >&2
>   exit 7
> fi
> git -c user.name=t -c user.email=t@example.invalid merge --no-ff -q "$target"
> SH
$ chmod +x merge-if-clean.sh
$ git bay init
bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)
$ git config bay.queue.batch-size 2
$ git config bay.autoMerge false
$ git config bay.mergeCommand './merge-if-clean.sh {target}'
$ git config bay.check 'test ! -f bad.txt'
$ git switch -qc task/good main && echo ok > good.txt && git add good.txt && git commit -qm good && git switch -q main
$ git switch -qc task/bad main && echo bad > bad.txt && git add bad.txt && git commit -qm bad && git switch -q main
$ git bay adopt task/good
PR1
$ git bay adopt task/bad
PR2
$ git bay submit PR1
bay: PR1 submitted — git bay integrate PR1 to land it
$ git bay submit PR2
bay: PR2 submitted — git bay integrate PR2 to land it
$ git bay integrate
bay: batch PR3 composed — members: PR1, PR2
bay: batch PR3 built — members: PR1, PR2
bay: PR3 submitted → checking
bay: PR3 checking → rejected — check 'test ! -f bad.txt' failed (exit 1):{{red_check_tail:/.*$/}}
bay: PR2 ejected from batch PR3 — first red batch prefix bay/batch-prefix/PR3/2-PR2 failed gate 'test ! -f bad.txt'. Rebuilding batch without it; remainder will land. Fix and retry: git bay retry PR2.
bay: batch PR4 built — members: PR1
bay: PR4 submitted → checking
bay: PR4 checking → checked
bay: PR4 checked → merging
bay: PR4 merging → merged
bay: PR1 checking → merged — merged via batch PR4 (candidate {{red_settled:/.*$/}}
$ git bay ls PR2
PR2 rejected — bay: PR2 ejected from batch PR3 — first red batch prefix bay/batch-prefix/PR3/2-PR2 failed gate 'test ! -f bad.txt'. Rebuilding batch without it; remainder will land. Fix and retry: git bay retry PR2.
```
