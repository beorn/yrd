export default {
  name: "yrd",
  services: {
    // Mechanical queue runner — never ambient @chief (22728). State-write
    // authority requires a verified managed-launch proof; this service is a
    // non-chief actor with its own tribe name for attribution only.
    "yrd-runner": {
      command: "yrd queue run --follow",
      env: { TRIBE_NAME: "@yrd" },
      health: {
        command:
          '"${HAB_MODULE_ROOT:-$PWD}/tools/installed/yrd" --repo "${HAB_MODULE_SOURCE_ROOT:?}" queue list --check --json',
      },
    },
    "yrd-gc": { command: "yrd admin pr prune", every: "1h" },
    "yrd-bay-prune": { command: "yrd admin bay prune --apply --json", every: "1h" },
  },
}
