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
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { compareVersions, MIN_APP_VERSION } from './resolve-lib.mjs'

export const APPCAST_URL =
  'https://ota.phibrowser.com/mac-public/appcast/v2/PhiBrowserMacUpdate.xml'
// Info.plist SUPublicEDKey of the stable channel, and the Developer ID team
// every Phi build is signed with.
const SPARKLE_ED_PUBKEY = 'eu4wYg6JQMROgPO7MjCHhVSZ+hcmjAEqmc1gecvGWSA='
const TEAM_ID = '87DQ3HMK5G'
// SPKI DER prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const attr = (s, name) => new RegExp(`${name}="([^"]*)"`).exec(s)?.[1] ?? null

/** Newest full release on the stable channel: {version, url, length, signature}. */
export async function latestRelease(fetchImpl = fetch) {
  const res = await fetchImpl(APPCAST_URL)
  if (!res.ok) throw new Error(`appcast ${APPCAST_URL} -> HTTP ${res.status}`)
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
    version: /<sparkle:shortVersionString>([^<]+)/.exec(item)?.[1]?.trim() ??
             attr(enclosure, 'sparkle:shortVersionString'),
    url,
    length: Number(attr(enclosure, 'length')) || 0,
    signature: attr(enclosure, 'sparkle:edSignature'),
  }
}

/** True when this release is new enough for the CLI to drive. */
export const releaseIsUsable = (release) =>
  compareVersions(release.version, MIN_APP_VERSION) !== -1

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
 * Download, verify, and install the newest stable Phi Browser.
 * `log` receives human-facing progress lines, `into` overrides the install
 * directory (tests point it at a scratch dir). Returns the installed path.
 */
export async function installBrowser({ log = () => {}, release, into } = {}) {
  const rel = release ?? await latestRelease()
  const work = await mkdtemp(join(tmpdir(), 'phibrowser-install-'))
  const archive = join(work, 'Phi.zip')
  try {
    const mb = (n) => `${(n / 1e6).toFixed(0)} MB`
    log(`Downloading Phi Browser ${rel.version} (${mb(rel.length)})…`)
    let lastShown = 0
    await download(rel.url, archive, (seen, total) => {
      const pct = total ? Math.floor((seen / total) * 100) : 0
      if (pct >= lastShown + 10) { lastShown = pct; log(`  ${pct}%`) }
    })

    const size = (await stat(archive)).size
    if (rel.length && size !== rel.length) {
      throw new Error(`downloaded ${size} bytes, appcast said ${rel.length}`)
    }
    log('Verifying signature…')
    verifyArchive(await readFile(archive), rel.signature)

    // ditto preserves the bundle's symlinks and resource forks; unzip(1) does not.
    execFileSync('ditto', ['-x', '-k', archive, work], { stdio: 'ignore' })
    const unpacked = join(work, 'Phi.app')
    verifyCodeSignature(unpacked)

    const dest = join(into ?? installRoot(), 'Phi.app')
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
