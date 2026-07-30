export default {
  name: "yrd",
  services: {
    "yrd-runner": {
      command: "yrd queue run --follow",
      env: { TRIBE_NAME: "@chief" },
      health: { command: '"${HAB_MODULE_ROOT:-$PWD}/tools/installed/yrd" queue list --check --json' },
      restart: "on-failure" as const,
    },
    "yrd-gc": { command: "yrd admin pr prune", every: "1h" },
    "yrd-bay-prune": { command: "yrd admin bay prune --apply --json", every: "1h" },
  },
}
