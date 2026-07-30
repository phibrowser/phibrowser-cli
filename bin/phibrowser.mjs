#!/usr/bin/env node
// Copyright 2026 Phinomenon Inc.
//
// phibrowser entry point. See src/cli.mjs for the command surface.

// The argv[0] brand Phi's AgentPeerIdentity recognizes as skill plumbing
// (ownBrandNames): without it the app names this process by its script path
// and mints a fresh driver principal that cannot see the driving agent's
// Spaces. Must be set before the first app-socket connection.
process.title = 'phibrowser-cli'

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`phibrowser: Node >= 22 required (running ${process.version})`)
  process.exit(2)
}

const { main, disposeHelpers } = await import('../src/cli.mjs')

// Mirror the skill runner's lifecycle discipline: a floating rejection or a
// kill signal must still flip the Space's busy badge back to idle.
for (const event of ['unhandledRejection', 'uncaughtException']) {
  process.on(event, (err) => {
    console.error(`phibrowser ${event}: ${err?.message || err}`)
    disposeHelpers().finally(() => process.exit(1))
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    disposeHelpers().finally(() => process.exit(130))
  })
}

let code = 1
try {
  code = await main(process.argv.slice(2))
} finally {
  await disposeHelpers()
}
process.exit(code)
