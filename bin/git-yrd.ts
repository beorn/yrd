#!/usr/bin/env bun
// git-yrd — alias entrypoint so `git yrd <verb>` works exactly like
// `git bay <verb>` during the Gitbay → Yrd identity transition (docs/yrd.md).
// Same process.argv, same implementation, zero fork.
import "./git-bay.ts"
