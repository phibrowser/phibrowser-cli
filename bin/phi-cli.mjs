#!/usr/bin/env node
// Copyright 2026 Phinomenon Inc.
//
// Entry point for both `phi` and its `phibrowser` alias. See src/cli.mjs
// for the command surface.

// The argv[0] brand Phi's AgentPeerIdentity recognizes as skill plumbing
// (ownBrandNames): without it the app names this process by its script path
// and mints a fresh driver principal that cannot see the driving agent's
// Spaces. Must be set before the first app-socket connection.
process.title = 'phibrowser-cli'

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`phi: Node >= 22 required (running ${process.version})`)
  process.exit(2)
}

// Apple silicon Macs only, matching the browser builds the CLI drives. The
// hardware is the gate, not the Node build: an x64 Node under Rosetta on an
// Apple silicon Mac (sysctl.proc_translated = 1) still passes.
if (process.platform !== 'darwin') {
  console.error('phi: macOS on Apple silicon required (drives the Phi Browser mac app)')
  process.exit(2)
}
if (process.arch !== 'arm64') {
  let translated = '0'
  try {
    const { execFileSync } = await import('node:child_process')
    translated = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* Intel Macs do not define the key */ }
  if (translated !== '1') {
    console.error('phi: Apple silicon Mac required — Intel Macs are not supported')
    process.exit(2)
  }
}

const { main, disposeHelpers } = await import('../src/cli.mjs')

// Mirror the skill runner's lifecycle discipline: a floating rejection or a
// kill signal must still flip the Space's busy badge back to idle.
for (const event of ['unhandledRejection', 'uncaughtException']) {
  process.on(event, (err) => {
    console.error(`phi ${event}: ${err?.message || err}`)
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
} catch (err) {
  // main() maps every expected failure to an exit code; anything reaching here
  // is a bug, and must still read as a CLI error rather than a bare rejection.
  console.error(`phi: ${err?.stack || err?.message || err}`)
} finally {
  await disposeHelpers()
}
process.exit(code)
