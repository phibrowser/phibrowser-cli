#!/usr/bin/env node
// Copyright 2026 Phinomenon Inc.
//
// Points Formula/phibrowser.rb at this package.json's version and stamps the
// tarball's sha256, so `brew install` and `npm install` always ship the same
// bytes. Two sources for those bytes:
//
//   npm run formula            registry (authoritative — use after publishing)
//   npm run formula -- --local `npm pack` output (pre-publish; npm uploads the
//                              packed tarball verbatim, so the hash matches)
//
// --check verifies without writing, for CI or a pre-publish sanity pass.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const formulaPath = join(pkgRoot, 'Formula', 'phibrowser.rb')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const local = args.includes('--local')
const check = args.includes('--check')

// @phibrowser/cli -> https://registry.npmjs.org/@phibrowser/cli/-/cli-<v>.tgz
const bare = pkg.name.replace(/^@[^/]+\//, '')
const url = `https://registry.npmjs.org/${pkg.name}/-/${bare}-${pkg.version}.tgz`

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function packLocally() {
  const out = mkdtempSync(join(tmpdir(), 'phibrowser-pack-'))
  const name = execFileSync('npm', ['pack', '--pack-destination', out], {
    cwd: pkgRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().split('\n').pop()
  return readFileSync(join(out, name))
}

async function fetchTarball() {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}. ` +
      (res.status === 404
        ? `Publish ${pkg.name}@${pkg.version} first, or use --local.`
        : 'Registry unreachable?'))
  }
  return Buffer.from(await res.arrayBuffer())
}

let digest
try {
  digest = sha256(local ? packLocally() : await fetchTarball())
} catch (err) {
  console.error(`sync-formula: ${err.message}`)
  process.exit(1)
}

const before = readFileSync(formulaPath, 'utf8')
if (!/^\s*url\s+"[^"]*"/m.test(before) || !/^\s*sha256\s+"[^"]*"/m.test(before)) {
  console.error(`sync-formula: no url/sha256 stanza in ${formulaPath}`)
  process.exit(1)
}
const after = before
  .replace(/^(\s*url\s+)"[^"]*"/m, `$1"${url}"`)
  .replace(/^(\s*sha256\s+)"[^"]*"/m, `$1"${digest}"`)

if (check) {
  if (after === before) {
    console.log(`formula up to date — ${pkg.version} ${digest.slice(0, 12)}…`)
    process.exit(0)
  }
  console.error(`formula out of date for ${pkg.name}@${pkg.version}\n` +
    `  expected url    ${url}\n  expected sha256 ${digest}\n` +
    `Run: npm run formula${local ? ' -- --local' : ''}`)
  process.exit(1)
}

writeFileSync(formulaPath, after)
console.log(`${after === before ? 'unchanged' : 'updated'} Formula/phibrowser.rb`)
console.log(`  url    ${url}`)
console.log(`  sha256 ${digest}${local ? '  (from local npm pack)' : ''}`)
