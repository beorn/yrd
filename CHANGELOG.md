# yrd Changelog

## Unreleased

- `yrd-queue-core` reads a validated event queue and its change histories concurrently for listings, retaining the separate ref scopes and complete chain folds (25203).
- `yrd-cli` uses the combined queue/change read for `yrd list`, while keeping its fresh ref fence before rendering (25203).

- Queue-run failure exit 1 is exported as `QUEUE_RUN_FAILED_EXIT` and used by the failure paths.

- `hab.projects.ts` no longer declares `TRIBE_NAME` for the `yrd` service: hab scrubs every caller identity name
  at launch, a declared one included, so it never reached the process. The queue's notices speak as the service's
  name through the root's `tools/yrd-notify.ts`, which registers its own service launch under `HAB_SERVICE_NAME`
  (25478).
- `yrd queue up` answers its termination signal with one last health document: `absent`/`stopped`, no deadline,
  and `facts.serviceStopped: {by, reason, since}` read from the supervisor's intent file (`HAB_UNIT_INTENT_FILE`,
  verb `stop` only), then dies of the signal as before. The watch reads it as "stopped by X since T: reason"; a
  document left by a SIGKILL or a crash reads "stopped outside a graceful stop since T; hab ps <unit> has the
  supervisor's record". Every running document carries `facts.serviceStarted`, from a `start` intent or the
  default reason "started" (25430).
- `readUnitIntent("stop")` accepts a stop intent only when its `at` is at or after the reader's own process start
  (`writer.startedAt`), protecting against reading a previous stop's record left by a reasonless start. A missing,
  unparseable, or stale `at` records "no stop reason was recorded" without falling back to `now` (@cto 16ab7d00,
  25430 fix-forward).
- `readUnitIntent("start")` checks the start intent against the process start time (`writer.startedAt`) and its
  stated freshness bound (`record.freshnessSeconds`, default 60s); a respawn without a fresh intent reads as no
  intent, attributing the runner to plain "started" (@cto 186400e1, 25502).
