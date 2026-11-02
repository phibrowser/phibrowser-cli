#!/usr/bin/env node
// Copyright 2026 Phinomenon Inc.
//
// Publishes this package under both of its registry names at one version:
//
//   @phibrowser/cli   canonical — what the Homebrew formula installs
//   phibrowser        unscoped mirror, so `npm i -g phibrowser` also works
//
// The mirror is the same tarball with a different `name`, not a wrapper: it
// installs and runs standalone. package.json is restored in a finally block,
// so an interrupted run cannot leave the repo claiming to be the mirror.
//
//   node scripts/publish.mjs [--dry-run] [--only <name>]

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(pkgRoot, 'package.json')
const original = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(original)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const onlyAt = args.indexOf('--only')
const only = onlyAt === -1 ? null : args[onlyAt + 1]
const MIRROR = 'phibrowser'

// Inherited, so npm can ask for a one-time password or a browser approval.
const run = (cmd, cmdArgs) =>
  execFileSync(cmd, cmdArgs, { cwd: pkgRoot, stdio: 'inherit' })

/** Already on the registry at this exact version? Republishing is an error.
 *  An unpublished name 404s on stderr, which is the normal case here. */
function published(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'],
      { cwd: pkgRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() === version
  } catch { return false }
}

function publish(name, extra = []) {
  if (only && only !== name) return console.log(`skip     ${name} (--only ${only})`)
  if (published(name, pkg.version)) {
    return console.log(`exists   ${name}@${pkg.version} — already on the registry`)
  }
  if (dryRun) return console.log(`dry-run  would publish ${name}@${pkg.version}`)
  run('npm', ['publish', ...extra])
  console.log(`published ${name}@${pkg.version}`)
}

try {
  // Canonical first: its prepublishOnly preflight gates both, since the
  // mirror ships identical files.
  publish(pkg.name)

  // The mirror skips lifecycle scripts: preflight checks the Homebrew formula
  // against the *scoped* tarball URL, which the mirror deliberately is not.
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, name: MIRROR }, null, 2) + '\n')
  publish(MIRROR, ['--ignore-scripts'])
} finally {
  writeFileSync(pkgPath, original)
}
