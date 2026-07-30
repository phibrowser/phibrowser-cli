// Copyright 2026 Phinomenon Inc.
//
// Locates the phi-browser skill's helper library. The CLI is a thin command
// surface over that engine and never vendors a copy of it: the engine speaks
// to the app's CDP surface, so it must be the one that shipped with the Phi
// Browser build actually running. Resolution order:
//   1. $PHIBROWSER_CLI_LIB   explicit scripts/lib dir
//   2. $PHIBROWSER_APP       explicit Phi Browser bundle
//   3. sibling checkout      <cli>/../phibrowser-mac/tools/phi-browser-skill
//   4. installed Phi Browser /Applications/Phi.app, Phi Canary.app, ~/Applications
//   5. installed agent skill ~/.claude, ~/.codex, ~/.pi/agent, …
//
// (4) is what lets `npm i -g @phibrowser/cli` and `brew install phibrowser`
// work with nothing else installed: the app ships the whole skill under
// Contents/Resources/phi-browser-skill. (5) usually resolves to the same
// files — the installers link the agent skill dirs at that bundle path.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// Canary first, matching the order the engine itself probes for the app
// socket (cdp.mjs): whichever browser a round will drive, load that build's
// engine, so the two never skew when both apps are installed.
const APP_NAMES = ['Phi Canary.app', 'Phi.app']
const AGENT_SKILL_DIRS = [
  ['.claude', 'skills'],
  ['.codex', 'skills'],
  ['.cursor', 'skills'],
  ['.openclaw', 'skills'],
  ['.hermes', 'skills'],
  ['.pi', 'agent', 'skills'],
]

const skillLib = (skillRoot) => join(skillRoot, 'scripts', 'lib')
const appLib = (app) => skillLib(join(app, 'Contents', 'Resources', 'phi-browser-skill'))

function appCandidates() {
  const dirs = ['/Applications', join(homedir(), 'Applications')]
  return dirs.flatMap((dir) => APP_NAMES.map((name) => appLib(join(dir, name))))
}

export function libCandidates() {
  return [
    process.env.PHIBROWSER_CLI_LIB,
    process.env.PHIBROWSER_APP && appLib(process.env.PHIBROWSER_APP),
    skillLib(join(pkgRoot, '..', 'phibrowser-mac', 'tools', 'phi-browser-skill')),
    ...appCandidates(),
    ...AGENT_SKILL_DIRS.map((parts) => skillLib(join(homedir(), ...parts, 'phi-browser'))),
  ].filter(Boolean)
}

export function resolveLibDir() {
  for (const dir of libCandidates()) {
    if (existsSync(join(dir, 'helpers.mjs'))) return dir
  }
  throw new Error(
    'phibrowser: cannot find the phi-browser helper library (helpers.mjs).\n' +
    'The CLI drives Phi Browser and loads the engine that ships inside the app,\n' +
    'so Phi Browser must be installed — https://phibrowser.com — or point\n' +
    'PHIBROWSER_APP at its bundle (or PHIBROWSER_CLI_LIB at a scripts/lib dir).\n' +
    'Looked in:\n' + libCandidates().map((d) => `  - ${d}`).join('\n'))
}

export async function loadHelpers() {
  const dir = resolveLibDir()
  return import(pathToFileURL(join(dir, 'helpers.mjs')).href)
}
