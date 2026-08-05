// Copyright 2026 Phinomenon Inc.
//
// Installs Phi Browser from the same Sparkle feed the app updates itself
// from. Trust is pinned here, not discovered: the CLI ships the feed URL,
// Sparkle's EdDSA public key, and the Developer ID team, so a fresh machine
// with no Phi Browser on it still has something to check the download
// against. Order matters — the archive's signature is verified before any
// of it is unpacked, and the unpacked app's code signature before it is
// moved anywhere.

import { execFileSync } from 'node:child_process'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { accessSync, constants, createWriteStream } from 'node:fs'
import { mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { compareVersions, MIN_APP_VERSION } from './resolve-lib.mjs'

// The two release channels the app itself updates from. Both are signed with
// the same EdDSA key and Developer ID team; only the feed differs. The canary
// feed publishes at the unversioned path — it has no /v2/ variant.
export const CHANNELS = {
  stable: {
    label: 'Phi Browser',
    appcast: 'https://ota.phibrowser.com/mac-public/appcast/v2/PhiBrowserMacUpdate.xml',
  },
  canary: {
    label: 'Phi Canary',
    appcast: 'https://ota.phibrowser.com/mac-nightly/appcast/PhiBrowserMacUpdate.xml',
  },
}

export const APPCAST_URL = CHANNELS.stable.appcast
// Info.plist SUPublicEDKey of the stable channel, and the Developer ID team
// every Phi build is signed with.
const SPARKLE_ED_PUBKEY = 'eu4wYg6JQMROgPO7MjCHhVSZ+hcmjAEqmc1gecvGWSA='
const TEAM_ID = '87DQ3HMK5G'
// SPKI DER prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const attr = (s, name) => new RegExp(`${name}="([^"]*)"`).exec(s)?.[1] ?? null

/** Newest full release on a channel: {channel, version, build, url, length,
 *  signature}. `version` is the marketing string ("2.4.0", or "Nightly" on
 *  canary, where `build` carries the number that actually moves). */
export async function latestRelease({ channel = 'stable', fetchImpl = fetch } = {}) {
  const appcast = (CHANNELS[channel] ?? CHANNELS.stable).appcast
  const res = await fetchImpl(appcast)
  if (!res.ok) throw new Error(`appcast ${appcast} -> HTTP ${res.status}`)
  const xml = await res.text()

  const item = /<item>[\s\S]*?<\/item>/.exec(xml)?.[0]
  if (!item) throw new Error('appcast has no <item> to install')
  // Skip binary deltas (sparkle:deltaFrom) — those patch an existing install.
  const enclosure = [...item.matchAll(/<enclosure\b[\s\S]*?\/>/g)]
    .map((m) => m[0])
    .find((e) => !/sparkle:deltaFrom=/.test(e))
  if (!enclosure) throw new Error('appcast item has no full-download enclosure')

  const url = attr(enclosure, 'url')
  if (!url || !url.startsWith('https://ota.phibrowser.com/')) {
    throw new Error(`refusing a download from outside the update host: ${url}`)
  }
  return {
    channel,
    version: /<sparkle:shortVersionString>([^<]+)/.exec(item)?.[1]?.trim() ??
             attr(enclosure, 'sparkle:shortVersionString'),
    build: /<sparkle:version>([^<]+)/.exec(item)?.[1]?.trim() ??
           attr(enclosure, 'sparkle:version'),
    url,
    length: Number(attr(enclosure, 'length')) || 0,
    signature: attr(enclosure, 'sparkle:edSignature'),
  }
}

/** True when this release is new enough for the CLI to drive. */
export const releaseIsUsable = (release) =>
  compareVersions(release.version, MIN_APP_VERSION) !== -1

/** Human name of a release: dotted stable versions stand alone ("2.4.0");
 *  named channel builds append the build number ("Nightly 736"). */
export const releaseLabel = (release) =>
  release.build && !/^\d+(\.\d+)*$/.test(String(release.version ?? ''))
    ? `${release.version} ${release.build}`
    : String(release.version)

function verifyArchive(bytes, signature) {
  if (!signature) throw new Error('release has no EdDSA signature — refusing to install')
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(SPARKLE_ED_PUBKEY, 'base64')]),
    format: 'der',
    type: 'spki',
  })
  if (!verifySignature(null, bytes, key, Buffer.from(signature, 'base64'))) {
    throw new Error('download failed its Sparkle signature check — not installing it')
  }
}

// Pin the team through a designated requirement so codesign evaluates it —
// scraping `codesign -dv` invites the mistake of reading the wrong stream
// (it reports on stderr) and silently pinning nothing.
const PHI_REQUIREMENT =
  `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`

function verifyCodeSignature(app) {
  try {
    execFileSync('codesign', ['--verify', '--strict', '-R', PHI_REQUIREMENT, app],
      { stdio: 'ignore' })
  } catch {
    throw new Error(`${app} is not validly signed by Phi's Developer ID team ` +
      `(${TEAM_ID}) — not installing it`)
  }
  try {
    execFileSync('spctl', ['--assess', '--type', 'execute', app], { stdio: 'ignore' })
  } catch { throw new Error(`${app} was rejected by Gatekeeper — not installing it`) }
}

async function download(url, dest, onProgress) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} -> HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let seen = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (chunk) => {
    seen += chunk.length
    onProgress?.(seen, total)
  })
  await pipeline(body, createWriteStream(dest))
  return seen
}

/** Where to put it: /Applications, or ~/Applications when that is not ours
 *  to write (the resolver searches both). */
function installRoot() {
  try {
    accessSync('/Applications', constants.W_OK)
    return '/Applications'
  } catch { return join(homedir(), 'Applications') }
}

/**
 * Download, verify, and install the newest Phi Browser of a channel (the
 * release's `channel` decides — stable installs `Phi.app`, canary installs
 * `Phi Canary.app`, each named by the archive itself).
 * `log` receives human-facing progress lines; `progress` — an optional
 * `{update(seen, total), done()}` — takes over download reporting (an
 * interactive caller passes an in-place meter; without one, plain percent
 * lines go through `log`). `into` overrides the install directory (tests
 * point it at a scratch dir). Returns the installed path.
 */
export async function installBrowser({ log = () => {}, progress, release, into } = {}) {
  const rel = release ?? await latestRelease()
  const label = (CHANNELS[rel.channel] ?? CHANNELS.stable).label
  const work = await mkdtemp(join(tmpdir(), 'phibrowser-install-'))
  const archive = join(work, 'Phi.zip')
  try {
    const mb = (n) => `${(n / 1e6).toFixed(0)} MB`
    log(`Downloading ${label} ${releaseLabel(rel)} (${mb(rel.length)})…`)
    let lastShown = 0
    const update = progress?.update ?? ((seen, total) => {
      const pct = total ? Math.floor((seen / total) * 100) : 0
      if (pct >= lastShown + 10) { lastShown = pct; log(`  ${pct}%`) }
    })
    await download(rel.url, archive, update)
    progress?.done?.()

    const size = (await stat(archive)).size
    if (rel.length && size !== rel.length) {
      throw new Error(`downloaded ${size} bytes, appcast said ${rel.length}`)
    }
    log('Verifying signature…')
    verifyArchive(await readFile(archive), rel.signature)

    // ditto preserves the bundle's symlinks and resource forks; unzip(1) does not.
    execFileSync('ditto', ['-x', '-k', archive, work], { stdio: 'ignore' })
    // The archive names the bundle (Phi.app on stable, Phi Canary.app on
    // canary) and the install keeps that name — the two channels are separate
    // apps that coexist, so neither may ever overwrite the other.
    const appNames = (await readdir(work)).filter((n) => n.endsWith('.app'))
    if (appNames.length !== 1) {
      throw new Error(`expected one .app in the archive, found ${appNames.length}`)
    }
    const unpacked = join(work, appNames[0])
    verifyCodeSignature(unpacked)

    const dest = join(into ?? installRoot(), appNames[0])
    const backup = `${dest}.replaced-${process.pid}`
    let replaced = false
    try { await rename(dest, backup); replaced = true } catch { /* nothing there */ }
    try {
      execFileSync('ditto', [unpacked, dest], { stdio: 'ignore' })
    } catch (err) {
      if (replaced) await rename(backup, dest).catch(() => {})
      throw new Error(`could not install into ${dest}: ${err.message}`)
    }
    if (replaced) await rm(backup, { recursive: true, force: true }).catch(() => {})
    log(`Installed ${dest}`)
    return dest
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
