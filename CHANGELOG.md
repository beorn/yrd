# yrd Changelog

## Unreleased

- `yrd queue up` answers its termination signal with one last health document: `absent`/`stopped`, no deadline,
  and `facts.serviceStopped: {by, reason, since}` read from the supervisor's intent file (`HAB_UNIT_INTENT_FILE`,
  verb `stop` only), then dies of the signal as before. The watch reads it as "stopped by X since T: reason"; a
  document left by a SIGKILL or a crash reads "stopped outside a graceful stop since T; hab ps <unit> has the
  supervisor's record". Every running document carries `facts.serviceStarted`, from a `start` intent or the
  default reason "started" (25430).
