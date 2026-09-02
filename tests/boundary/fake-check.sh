#!/bin/sh
# A check whose result the TEST chooses, not the code under test.
#
# The queue-run boundary harness configures this as the target's only check,
# so one script covers the whole ladder — pass, fail, stuck, slow — without
# the harness ever reaching inside the queue to stage a result. Every knob is
# an environment variable, set inline in the `run:` command the fixture writes
# into `.yrd.yml`, so two tests in one file never share state.
#
#   FAKE_CHECK_EXIT   status to exit with (default 0)
#   FAKE_CHECK_SLEEP  seconds to sleep before exiting (default 0)
#   FAKE_CHECK_LOG    file to append one line to, when set
set -u

sleep "${FAKE_CHECK_SLEEP:-0}"

if [ -n "${FAKE_CHECK_LOG:-}" ]; then
  printf 'fake-check exit=%s cwd=%s\n' "${FAKE_CHECK_EXIT:-0}" "$(pwd)" >>"${FAKE_CHECK_LOG}"
fi

exit "${FAKE_CHECK_EXIT:-0}"
