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

import { execFileSync } from 'node:child_process'
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

export const DOWNLOAD_URL = 'https://phibrowser.com'

// The release that introduced the agent-Space surface the CLI drives. Older
// builds have no engine to load and no Settings toggle to turn on, so they
// need "update the app", never "enable the feature".
export const MIN_APP_VERSION = '2.4.0'

// Lands in Settings ▸ General, which hosts the Developer section.
export const SETTINGS_DEEPLINK = 'phi://native/openpage?page=settings&section=general'

/** CFBundleShortVersionString, or null when it cannot be read. */
export function readAppVersion(app) {
  try {
    return execFileSync('plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch { return null }
}

/** -1 / 0 / 1, or null when either side is not a dotted number — channel
 *  builds are named ("Nightly"), and a name is never treated as too old. */
export function compareVersions(a, b) {
  const parse = (v) => /^\d+(\.\d+)*$/.test(String(v ?? '').trim())
    ? String(v).trim().split('.').map(Number) : null
  const [x, y] = [parse(a), parse(b)]
  if (!x || !y) return null
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

export const isCanaryBundle = (app) => /\/Phi Canary\.app\/?$/.test(app)

/**
 * Canary is exempt from the version gate: it is the prerelease channel, it
 * versions itself by name rather than by number, and it is always ahead of
 * the numbered releases. Only stable Phi.app is ever called too old.
 */
export function describeApp(app) {
  const canary = isCanaryBundle(app)
  return { app, canary, version: canary ? null : readAppVersion(app) }
}

/** Capable = Canary, or a stable build that is not provably below the floor
 *  (an unnumbered stable dev build is given the benefit of the doubt). */
export const isCapableApp = ({ canary, version }) =>
  canary || compareVersions(version, MIN_APP_VERSION) !== -1

/**
 * What is installed and whether any of it can be driven. `outdated` is true
 * only when NO installed bundle is capable — with a capable build present,
 * that is the one a round reaches.
 */
export function appStatus() {
  const apps = appBundles()
    .filter((app) => existsSync(join(app, 'Contents', 'MacOS')))
    .map(describeApp)
  const capable = apps.find(isCapableApp)
  const chosen = capable ?? apps[0] ?? null
  return {
    app: chosen?.app ?? null,
    version: chosen?.version ?? null,
    canary: Boolean(chosen?.canary),
    outdated: apps.length > 0 && !capable,
    apps,
  }
}

/**
 * Every place a Phi Browser bundle may live, in resolution order.
 * $PHIBROWSER_APP is exclusive: naming a bundle means "drive that one", so a
 * wrong value is reported rather than silently swapped for another install.
 */
export function appBundles() {
  if (process.env.PHIBROWSER_APP) return [process.env.PHIBROWSER_APP]
  const dirs = ['/Applications', join(homedir(), 'Applications')]
  return dirs.flatMap((dir) => APP_NAMES.map((name) => join(dir, name)))
}

/** The installed Phi Browser bundle, or null when the app is absent. */
export function findAppBundle() {
  return appBundles().find((app) => existsSync(join(app, 'Contents', 'MacOS'))) ?? null
}

export function libCandidates() {
  // $PHIBROWSER_APP pins the app, $PHIBROWSER_CLI_LIB pins the engine: with a
  // bundle named, the implicit fallbacks are off — falling back to a checkout
  // or another agent's skill link would drive one app with another's engine.
  if (process.env.PHIBROWSER_APP) {
    return [process.env.PHIBROWSER_CLI_LIB, appLib(process.env.PHIBROWSER_APP)].filter(Boolean)
  }
  return [
    process.env.PHIBROWSER_CLI_LIB,
    skillLib(join(pkgRoot, '..', 'phibrowser-mac', 'tools', 'phi-browser-skill')),
    ...appBundles().map(appLib),
    ...AGENT_SKILL_DIRS.map((parts) => skillLib(join(homedir(), ...parts, 'phi-browser'))),
  ].filter(Boolean)
}

/**
 * Throws with `err.code` distinguishing the two ways this fails, because they
 * need opposite advice: a missing app is fixed by installing Phi Browser, a
 * missing engine inside a present app is not.
 */
export function resolveLibDir() {
  for (const dir of libCandidates()) {
    if (existsSync(join(dir, 'helpers.mjs'))) return dir
  }
  const app = findAppBundle()
  const misdirected = !app && process.env.PHIBROWSER_APP
  const err = new Error(app
    ? `Phi Browser at ${app} does not ship the automation engine ` +
      '(phi-browser-skill) — update to a current build, or point ' +
      'PHIBROWSER_CLI_LIB at a scripts/lib dir.'
    : misdirected
      ? `no Phi Browser bundle at ${process.env.PHIBROWSER_APP} ` +
        '($PHIBROWSER_APP). Unset it to search /Applications, or install ' +
        `Phi Browser (free, macOS): ${DOWNLOAD_URL}`
      : 'Phi Browser is not installed. The CLI drives the app and loads the ' +
        'automation engine that ships inside it — install Phi Browser ' +
        `(free, macOS): ${DOWNLOAD_URL}`)
  err.code = app ? 'phi_engine_missing' : 'phi_not_installed'
  err.app = app
  err.searched = libCandidates()
  throw err
}

export async function loadHelpers() {
  const dir = resolveLibDir()
  return import(pathToFileURL(join(dir, 'helpers.mjs')).href)
}
