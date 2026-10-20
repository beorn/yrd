# Yrd compared with other merge queues

The [README](../README.md) has the short version. Here is the full comparison. A gitlink is a submodule pointer: the commit a superproject records for one of its submodules.

|                         | What is tested                                                    | What merges                                                             | Where the state lives                        | Superproject                                                            |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| **Yrd**                 | the merge of the queue branch and the change, in a fresh checkout | that same merge commit                                                  | commits on refs in the repository; no server | gitlinks checked and materialized                                       |
| **GitHub merge queue**  | several queued pull requests merged together and tested as one    | that group's result                                                     | GitHub                                       | none: the tree merges, gitlinks unread                                  |
| **GitLab merge trains** | a pipeline per position in the train                              | GitLab's merge                                                          | GitLab                                       | none                                                                    |
| **Gerrit**              | the patch set                                                     | per submit strategy; rebase or cherry-pick can mint a sha nobody tested | git refs on the Gerrit server                | gitlinks can be updated after a merge, not checked before it            |
| **Zuul**                | a test merge of the whole train ahead, before the forge merges    | whatever the forge then merges                                          | the forge plus ZooKeeper                     | many repositories per change, named in its project config, not gitlinks |
| **bors-ng**             | a staging merge of the batch                                      | the exact staging sha, fast-forwarded                                   | its own database                             | none                                                                    |

What each choice costs, in both directions:

- **bors-ng made the rule famous**: test the merge, then ship exactly what you tested. Yrd keeps that rule, needs no forge to hold the queue, and checks gitlinks.
- **Squash and rebase merges buy a clean linear log**, which is a real win for casual reading, and GitHub's and GitLab's queues offer them. The price is that the commit you authored never becomes `main`, so "is my exact commit in" has no ancestry answer. Yrd pays the opposite price, merge commits in the log, and buys the answer back with `git log --first-parent`.
- **Gerrit's change identity survives any number of revisions.** Yrd's `Change:` trailer on the merge commit and its per-change ref are the same idea at the git layer, without the server, the amend-and-push ceremony, or a submit strategy that merges an untested sha.
- **Zuul tests a merge of the whole train ahead** before the forge merges anything, checking against that projected future rather than live trunk, which is the fastest way through a busy queue. Yrd merges one change per round and checks the next merge against the new queue branch, which is slower and needs no rollback of a broken train.

The common thread: every system above answers "what exactly did we test, and is that what merged" with some mixture of trusting the tool and comparing contents. Yrd's answer is a sha you can check from any clone with nothing but git.
