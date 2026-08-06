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
        command: 'tools/installed/yrd --repo "$PWD" queue list --check --json',
      },
    },
  },
}
