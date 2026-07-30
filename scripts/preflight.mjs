#!/usr/bin/env node
// Copyright 2026 Phinomenon Inc.
//
// Runs as `prepublishOnly`: the last gate before bytes leave the machine.
// Checks what a broken publish would otherwise teach us in production —
// an unrunnable bin, a tarball carrying junk (or missing the skill file
// `install --skills` writes), and a Homebrew formula left on the old version.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const problems = []
const fail = (msg) => problems.push(msg)

// 1. The bin must be directly executable: npm sets the mode on install, but a
// non-shebang'd or unreadable entry point fails only at the user's shell.
// Both `phi` and its `phibrowser` alias must resolve to a runnable entry.
const binPaths = [...new Set(Object.values(pkg.bin))]
if (!pkg.bin.phi || !pkg.bin.phibrowser) fail('package.json bin must declare phi and phibrowser')
const bin = join(pkgRoot, pkg.bin.phi ?? binPaths[0])
for (const rel of binPaths) {
  const abs = join(pkgRoot, rel)
  try {
    accessSync(abs, constants.X_OK)
    if (!readFileSync(abs, 'utf8').startsWith('#!/usr/bin/env node')) {
      fail(`${rel}: missing node shebang`)
    }
  } catch { fail(`${rel}: not executable (chmod +x)`) }
}

// 2. It must run, and agree with package.json about the version — `brew test`
// and the formula's version stanza both assert on this string.
try {
  const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()
  if (out !== pkg.version) fail(`--version prints ${out}, package.json says ${pkg.version}`)
} catch (err) { fail(`--version failed: ${err.message}`) }

// 3. Tarball contents: everything the CLI reads at runtime, nothing else.
const listed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: pkgRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}))[0].files.map((f) => f.path)

for (const required of ['bin/phi-cli.mjs', 'src/cli.mjs', 'src/render.mjs',
                        'src/resolve-lib.mjs', 'skill/SKILL.md', 'LICENSE', 'README.md']) {
  if (!listed.includes(required)) fail(`tarball is missing ${required}`)
}
for (const path of listed) {
  if (/^(test|scripts|Formula)\//.test(path) || path.startsWith('.')) {
    fail(`tarball should not ship ${path}`)
  }
}

// 4. Homebrew installs the registry tarball, so a formula left on the old
// version or hash silently keeps shipping the old CLI — or fails to install
// at all. Checked against a local pack; re-stamp from the registry once
// published (RELEASING.md).
try {
  execFileSync(process.execPath, [join(pkgRoot, 'scripts', 'sync-formula.mjs'), '--local', '--check'],
    { cwd: pkgRoot, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
} catch (err) {
  fail(`Formula/phi-cli.rb is stale — run: npm run formula -- --local\n` +
       String(err.stderr || '').trim().split('\n').map((l) => `      ${l}`).join('\n'))
}

if (problems.length) {
  console.error(`preflight failed for ${pkg.name}@${pkg.version}:`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`preflight ok — ${pkg.name}@${pkg.version}, ${listed.length} files`)
