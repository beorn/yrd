# yrd Changelog

## Unreleased

- A graceful stop uses the supervisor's stop intent only when it was written after this runner started: a signal
  no intent write preceded (a custody or pty stop, a plain `kill`) no longer records the previous stop's who and why,
  and reads "no stop reason was recorded" (25430 review P2). A start intent (`hab up yrd --reason`, 25466) names who
  started the runner and why on its first document.
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
