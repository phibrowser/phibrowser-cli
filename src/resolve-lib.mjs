// Copyright 2026 Phinomenon Inc.
//
// Locates the phi-browser skill's helper library. The CLI is a thin command
// surface over that engine — it never duplicates it. Resolution order:
//   1. $PHIBROWSER_CLI_LIB          (explicit lib dir)
//   2. sibling repo checkout        (<cli>/../phibrowser-mac/tools/phi-browser-skill)
//   3. installed agent skills      (~/.claude, ~/.codex, ~/.pi/agent)

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export function libCandidates() {
  return [
    process.env.PHIBROWSER_CLI_LIB,
    join(pkgRoot, '..', 'phibrowser-mac', 'tools', 'phi-browser-skill', 'scripts', 'lib'),
    join(homedir(), '.claude', 'skills', 'phi-browser', 'scripts', 'lib'),
    join(homedir(), '.codex', 'skills', 'phi-browser', 'scripts', 'lib'),
    join(homedir(), '.pi', 'agent', 'skills', 'phi-browser', 'scripts', 'lib'),
  ].filter(Boolean)
}

export function resolveLibDir() {
  for (const dir of libCandidates()) {
    if (existsSync(join(dir, 'helpers.mjs'))) return dir
  }
  throw new Error(
    'phibrowser: cannot find the phi-browser helper library (helpers.mjs).\n' +
    'Looked in:\n' + libCandidates().map((d) => `  - ${d}`).join('\n') + '\n' +
    'Install the phi-browser skill, or point PHIBROWSER_CLI_LIB at a scripts/lib dir.')
}

export async function loadHelpers() {
  const dir = resolveLibDir()
  return import(pathToFileURL(join(dir, 'helpers.mjs')).href)
}
