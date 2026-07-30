#!/usr/bin/env node
// Copyright 2026 Phinomenon Inc.
//
// End-to-end test for the phibrowser CLI. Drives a real running Phi Browser
// (Canary or stable with CDP enabled) and exercises every command.
//
//   node test/cli.test.mjs
//
// Assertions read DOM state back through `eval` as the source of truth rather
// than parsing human-facing output. Flaky input paths (wheel scrolling) and
// interactive commands (handoff/takeover/watch) are smoke-checked or skipped
// with a reason, never failed. Everything created (agent Spaces, and — when
// browser-management is enabled — a throwaway user Space, bookmarks, a rule,
// a pin) is cleaned up in a finally block.
//
// Exit code: non-zero iff an AUTO assertion failed. SMOKE failures and SKIPs
// do not fail the suite.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'phibrowser.mjs')
const S = 'clitest'          // agent-Space session for the page tests
const TMP = mkdtempSync(join(tmpdir(), 'phib-clitest-'))

// ---------------------------------------------------------------------------
// Fixture: a self-contained page with every control kind the tests touch.

const FIXTURE_HTML = `<!doctype html><meta charset=utf-8><title>phib-selftest</title>
<h1 id=h>Selftest Fixture</h1><h2 id=h2>Section Two</h2>
<p>MARKERTEXT the quick brown fox jumps over 12345 lazy dogs</p>
<a id=lnk href="https://example.com/">golink</a>
<input id=txt placeholder="type here">
<input type=checkbox id=cb>
<select id=sel><option value=a>Alpha</option><option value=b>Beta</option></select>
<input type=range id=rng min=0 max=100 value=50 style="width:400px;display:block">
<textarea id=ta rows=3></textarea>
<input type=file id=file>
<button id=btn onclick="this.dataset.clicked='yes'">Go</button>
<form id=frm onsubmit="document.getElementById('out').textContent='submitted';return false"><input id=q></form>
<div id=out></div>
<div style="height:3000px;background:#eee">tall spacer</div>
<script>console.log('FIXTURE_READY');console.error('FIXTURE_ERROR_LINE');</script>`

const FIXTURE = 'data:text/html,' + encodeURIComponent(FIXTURE_HTML)

// ---------------------------------------------------------------------------
// Runner + assertions

function run(args, { input, timeoutMs = 60000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args],
      { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) })
    let out = '', err = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err, timedOut }) })
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out, err, timedOut }) })
    if (input !== undefined) child.stdin.end(input); else child.stdin.end()
  })
}

// Strip the lib's one-time stderr notice lines so they don't defeat matches.
const clean = (r) => (r.out + '\n' + r.err).split('\n').filter((l) => !l.startsWith('ℹ')).join('\n')

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail })
  const tag = { pass: '  ok ', fail: 'FAIL ', smoke: 'smoke', skip: 'skip ' }[status]
  process.stdout.write(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}\n`)
}

async function T(name, fn) {
  try { const d = await fn(); record(name, 'pass', typeof d === 'string' ? d : undefined) }
  catch (e) { record(name, 'fail', e.message) }
}
// Smoke: exercised, but a failure is reported (non-fatal to the exit code).
async function SMOKE(name, fn) {
  try { const d = await fn(); record(name, 'pass', typeof d === 'string' ? d : undefined) }
  catch (e) { record(name, 'smoke', e.message) }
}
const SKIP = (name, why) => record(name, 'skip', why)

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
function assertHas(hay, needle, ctx) {
  if (!String(hay).includes(needle)) {
    throw new Error(`${ctx || 'output'} missing ${JSON.stringify(needle)} — got: ${String(hay).slice(0, 160).replace(/\n/g, '⏎')}`)
  }
}
function assertOk(r, ctx) {
  if (r.timedOut) throw new Error(`${ctx || 'command'} TIMED OUT`)
  if (r.code !== 0) throw new Error(`${ctx || 'command'} exit ${r.code}: ${(r.err || r.out).slice(0, 160)}`)
  return r
}

// eval in the agent-Space page, returning trimmed stdout. Command flags
// (e.g. --on) follow the subcommand; only global flags precede it.
async function ev(expr, extra = []) {
  const r = await run(['-s', S, 'eval', expr, ...extra])
  assertOk(r, `eval ${expr}`)
  return r.out.trim()
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`phibrowser CLI e2e — bin=${BIN}\n`)

  // Preflight: is a browser reachable at all?
  const pre = await run(['sessions'], { timeoutMs: 30000 })
  if (pre.code !== 0 && /endpoint|not responding|denied|Node >=/.test(pre.err)) {
    console.error('Cannot reach Phi Browser CDP. Start Phi (Canary) with agent CDP enabled.\n' + pre.err)
    process.exit(2)
  }

  // ===== No usable browser =================================================
  // $PHIBROWSER_APP pins the app exclusively, so aiming it at nothing
  // simulates a machine without Phi Browser even on one that has it.
  console.log('\n# No browser')
  const ABSENT = { PHIBROWSER_APP: join(TMP, 'Absent.app') }
  await T('missing Phi Browser → exit 5, names the install', async () => {
    const r = await run(['open', FIXTURE], { env: ABSENT, timeoutMs: 30000 })
    assert(r.code === 5, `expected exit 5, got ${r.code}`)
    assertHas(clean(r), 'https://phibrowser.com', 'install prompt')
  })
  await T('missing Phi Browser → never blocks a non-TTY caller', async () => {
    const r = await run(['tabs'], { env: ABSENT, timeoutMs: 30000 })
    assert(!r.timedOut, 'CLI hung waiting on input')
    assert(!/\[Y\/n\]/.test(clean(r)), 'prompted a non-interactive caller')
  })
  await T('bundle without the engine → distinct diagnosis', async () => {
    const app = join(TMP, 'Engineless.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    const r = await run(['tabs'], { env: { PHIBROWSER_APP: app }, timeoutMs: 30000 })
    assert(r.code === 5, `expected exit 5, got ${r.code}`)
    assertHas(clean(r), 'does not ship the automation engine', 'engine-missing diagnosis')
  })

  // Version gate: stable below the floor is told to update; Canary is the
  // prerelease channel and is never judged on its version number.
  const fakeApp = (name, version) => {
    const app = join(TMP, name)
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
      `<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`)
    return app
  }
  await T('stable below 2.4.0 → update, not "enable" or "install"', async () => {
    const r = await run(['tabs'], { env: { PHIBROWSER_APP: fakeApp('Phi.app', '2.3.0') }, timeoutMs: 30000 })
    assert(r.code === 5, `expected exit 5, got ${r.code}`)
    assertHas(clean(r), 'older than 2.4.0', 'outdated diagnosis')
    assert(!/is not installed/.test(clean(r)), 'told an existing install it was absent')
  })
  await T('Canary is exempt from the version gate', async () => {
    const r = await run(['tabs'], { env: { PHIBROWSER_APP: fakeApp('Phi Canary.app', '2.3.0') }, timeoutMs: 30000 })
    assert(!/older than/.test(clean(r)), 'called Canary outdated')
    assert(!/is not installed/.test(clean(r)), 'told a Canary user to install')
  })

  // ===== Session bootstrap + page fixture ==================================
  console.log('\n# Session + Observe')
  await T('open (fixture)', async () => {
    const r = assertOk(await run(['-s', S, 'open', FIXTURE]), 'open')
    assertHas(clean(r), 'phib-selftest', 'open')
  })
  await T('info', async () => assertHas(clean(assertOk(await run(['-s', S, 'info']))), 'data:text/html', 'info'))
  await T('snapshot', async () => {
    const r = assertOk(await run(['-s', S, 'snapshot']))
    assertHas(clean(r), '### Page', 'snapshot'); assertHas(clean(r), 'loc=css:#sel', 'snapshot')
  })
  await T('snapshot --text', async () => {
    const r = assertOk(await run(['-s', S, 'snapshot', '--text']))
    assertHas(clean(r), 'UNTRUSTED', 'snapshot --text'); assertHas(clean(r), 'MARKERTEXT', 'snapshot --text')
  })
  await SMOKE('snapshot --diff', async () => assertOk(await run(['-s', S, 'snapshot', '--diff'])))
  await T('snapshot --filename', async () => {
    const f = join(TMP, 'snap.txt')
    assertOk(await run(['-s', S, 'snapshot', '--filename', f]))
    assert(existsSync(f) && readFileSync(f, 'utf8').includes('### Page'), 'file not written with page header')
  })
  await T('find', async () => assertHas(clean(assertOk(await run(['-s', S, 'find', 'MARKERTEXT']))), 'MARKERTEXT', 'find'))
  await T('find --regex', async () => assertHas(clean(assertOk(await run(['-s', S, 'find', '--regex', 'quick.*fox']))), 'quick', 'find --regex'))
  await T('eval', async () => assertHas(await ev('40+2'), '42', 'eval'))
  await T('eval --on', async () => assertHas(await ev('this.tagName', ['--on', 'css:#h']), 'H1', 'eval --on'))
  await T('console', async () => assertHas(clean(assertOk(await run(['-s', S, 'console']))), 'FIXTURE_READY', 'console'))
  await T('console --errors', async () => assertHas(clean(assertOk(await run(['-s', S, 'console', '--errors']))), 'FIXTURE_ERROR_LINE', 'console --errors'))
  await SMOKE('requests', async () => assertOk(await run(['-s', S, 'requests'])))
  await T('challenge', async () => assertHas(clean(assertOk(await run(['-s', S, 'challenge']))), 'no challenge', 'challenge'))

  // ===== Capture (smoke: file exists, non-empty) ===========================
  console.log('\n# Capture')
  for (const [name, args, ext] of [
    ['screenshot', ['screenshot'], 'png'],
    ['screenshot --annotated', ['screenshot', '--annotated'], 'png'],
    ['pdf', ['pdf'], 'pdf'],
    ['archive', ['archive'], 'mhtml'],
  ]) {
    await SMOKE(name, async () => {
      const f = join(TMP, `${name.replace(/\W+/g, '_')}.${ext}`)
      assertOk(await run(['-s', S, ...args, f]), name)
      assert(existsSync(f) && statSync(f).size > 0, 'output file missing/empty')
    })
  }

  // ===== Actions (assert via DOM readback) =================================
  console.log('\n# Act')
  await T('click', async () => {
    assertOk(await run(['-s', S, 'click', 'css:#btn']), 'click')
    assertHas(await ev("document.getElementById('btn').dataset.clicked||''"), 'yes', 'click effect')
  })
  await T('fill', async () => {
    assertOk(await run(['-s', S, 'fill', 'css:#txt', 'hello world']), 'fill')
    assertHas(await ev("document.getElementById('txt').value"), 'hello world', 'fill value')
  })
  await T('fill --submit', async () => {
    assertOk(await run(['-s', S, 'fill', 'css:#q', 'x', '--submit']), 'fill --submit')
    assertHas(await ev("document.getElementById('out').textContent"), 'submitted', 'form submit')
  })
  await T('type', async () => {
    assertOk(await run(['-s', S, 'click', 'css:#ta']))
    assertOk(await run(['-s', S, 'type', 'abc']), 'type')
    assertHas(await ev("document.getElementById('ta').value"), 'abc', 'type value')
  })
  await T('press', async () => {
    assertOk(await run(['-s', S, 'press', '!']), 'press')  // ta still focused
    assertHas(await ev("document.getElementById('ta').value"), 'abc!', 'press appended char')
  })
  await T('check', async () => {
    assertOk(await run(['-s', S, 'check', 'css:#cb']), 'check')
    assertHas(await ev("String(document.getElementById('cb').checked)"), 'true', 'check')
  })
  await T('uncheck', async () => {
    assertOk(await run(['-s', S, 'uncheck', 'css:#cb']), 'uncheck')
    assertHas(await ev("String(document.getElementById('cb').checked)"), 'false', 'uncheck')
  })
  await T('select', async () => {
    assertOk(await run(['-s', S, 'select', 'css:#sel', 'b']), 'select')
    assertHas(await ev("document.getElementById('sel').value"), 'b', 'select value')
  })
  await T('drag (slider)', async () => {
    const rect = JSON.parse(await ev("(function(){var r=document.getElementById('rng').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left),y:Math.round(r.top+r.height/2),w:Math.round(r.width)})})()"))
    const from = `${rect.x + Math.round(rect.w / 2)},${rect.y}`
    const to = `${rect.x + rect.w - 4},${rect.y}`
    assertOk(await run(['-s', S, 'drag', from, to]), 'drag')
    const val = Number(await ev("document.getElementById('rng').value"))
    assert(val > 50, `slider did not increase (value=${val})`)
  })
  await T('highlight / --hide', async () => {
    assertOk(await run(['-s', S, 'highlight', 'css:#sel']), 'highlight')
    assertHas(await ev("document.getElementById('sel').style.outline"), 'solid', 'highlight applied')
    assertOk(await run(['-s', S, 'highlight', '--hide']), 'highlight --hide')
    assert((await ev("document.getElementById('sel').style.outline")) === '""'.slice(0, 0) || !(await ev("document.getElementById('sel').style.outline")).includes('solid'), 'highlight not cleared')
  })
  await T('upload', async () => {
    const f = join(TMP, 'upload-me.txt'); writeFileSync(f, 'hi')
    assertOk(await run(['-s', S, 'upload', 'css:#file', f]), 'upload')
    assertHas(await ev("String(document.getElementById('file').files.length)"), '1', 'file attached')
  })
  await T('viewport', async () => {
    assertOk(await run(['-s', S, 'viewport', '540', '480']), 'viewport')
    assertHas(await ev('String(window.innerWidth)'), '540', 'viewport width')
  })
  await SMOKE('hover', async () => assertOk(await run(['-s', S, 'hover', 'css:#btn'])))
  await SMOKE('mousemove', async () => assertOk(await run(['-s', S, 'mousemove', '10', '10'])))
  await SMOKE('mousedown', async () => assertOk(await run(['-s', S, 'mousedown', '10', '10'])))
  await SMOKE('mouseup', async () => assertOk(await run(['-s', S, 'mouseup', '10', '10'])))
  await SMOKE('scroll', async () => assertOk(await run(['-s', S, 'scroll', '--dy', '400'], { timeoutMs: 10000 })))
  await SMOKE('mousewheel', async () => assertOk(await run(['-s', S, 'mousewheel', '0', '200'], { timeoutMs: 10000 })))
  await SMOKE('accept-cookies', async () => assertOk(await run(['-s', S, 'accept-cookies'])))
  await SMOKE('keydown/keyup', async () => {
    assertOk(await run(['-s', S, 'click', 'css:#txt']))
    assertOk(await run(['-s', S, 'keydown', 'Shift']))
    assertOk(await run(['-s', S, 'keyup', 'Shift']))
  })

  // ===== Wait ==============================================================
  console.log('\n# Wait')
  await T('wait <seconds>', async () => assertHas(clean(assertOk(await run(['-s', S, 'wait', '0.2']))), 'waited', 'wait'))
  await T('wait --element', async () => assertHas(clean(assertOk(await run(['-s', S, 'wait', '--element', 'css:#h']))), 'found', 'wait --element'))
  await T('wait --fn', async () => assertHas(clean(assertOk(await run(['-s', S, 'wait', '--fn', '2+2===4']))), 'true', 'wait --fn'))
  await SMOKE('wait --load', async () => assertOk(await run(['-s', S, 'wait', '--load'])))
  await SMOKE('wait --idle', async () => assertOk(await run(['-s', S, 'wait', '--idle'], { timeoutMs: 15000 })))

  // ===== Navigation + tabs =================================================
  console.log('\n# Navigation + Tabs')
  await T('goto', async () => assertHas(clean(assertOk(await run(['-s', S, 'goto', 'https://example.com']))), 'Example Domain', 'goto'))
  await SMOKE('reload', async () => assertOk(await run(['-s', S, 'reload'])))
  await SMOKE('back', async () => assertOk(await run(['-s', S, 'back'])))
  await SMOKE('forward', async () => assertOk(await run(['-s', S, 'forward'])))
  await T('tab-new + tabs', async () => {
    assertOk(await run(['-s', S, 'tab-new', 'https://example.org']), 'tab-new')
    const r = assertOk(await run(['-s', S, 'tabs']))
    assert((clean(r).match(/^\s*[*> ]?\d+\./gm) || []).length >= 2, 'expected >=2 tabs')
  })
  await SMOKE('tab-select', async () => assertOk(await run(['-s', S, 'tab-select', '1'])))
  await T('tab-close', async () => {
    const before = (clean(await run(['-s', S, 'tabs'])).match(/^\s*[*> ]?\d+\./gm) || []).length
    assertOk(await run(['-s', S, 'tab-close', String(before)]), 'tab-close')
    const after = (clean(await run(['-s', S, 'tabs'])).match(/^\s*[*> ]?\d+\./gm) || []).length
    assert(after === before - 1, `tab count ${before} -> ${after}`)
  })

  // ===== Storage (needs an http origin) ====================================
  console.log('\n# Storage')
  assertOk(await run(['-s', S, 'goto', 'https://example.com']), 'goto for storage')
  await T('cookie-set/get/list', async () => {
    assertOk(await run(['-s', S, 'cookie-set', 'phibk', 'phibv']), 'cookie-set')
    assertHas(clean(await run(['-s', S, 'cookie-get', 'phibk'])), 'phibk=phibv', 'cookie-get')
    assertHas(clean(await run(['-s', S, 'cookies'])), 'phibk', 'cookies')
  })
  await T('cookie-delete', async () => {
    assertOk(await run(['-s', S, 'cookie-delete', 'phibk']), 'cookie-delete')
    assertHas(clean(await run(['-s', S, 'cookie-get', 'phibk'])), 'no cookie', 'cookie gone')
  })
  await SMOKE('cookie-clear', async () => assertOk(await run(['-s', S, 'cookie-clear'])))
  for (const store of ['localstorage', 'sessionstorage']) {
    await T(`${store} set/get/list/delete/clear`, async () => {
      assertOk(await run(['-s', S, `${store}-set`, 'sk', 'sv']), `${store}-set`)
      assertHas(await ev(store === 'localstorage' ? "localStorage.getItem('sk')" : "sessionStorage.getItem('sk')"), 'sv', `${store} value`)
      assertHas(clean(await run(['-s', S, `${store}-get`, 'sk'])), 'sv', `${store}-get`)
      assertHas(clean(await run(['-s', S, `${store}-list`])), 'sk', `${store}-list`)
      assertOk(await run(['-s', S, `${store}-delete`, 'sk']), `${store}-delete`)
      assertOk(await run(['-s', S, `${store}-clear`]), `${store}-clear`)
    })
  }
  await SMOKE('state-save', async () => assertOk(await run(['-s', S, 'state-save', 'phibstate'])))
  await SMOKE('state-load', async () => assertOk(await run(['-s', S, 'state-load', 'phibstate'])))

  // ===== Session-level =====================================================
  console.log('\n# Session-level')
  await T('sessions', async () => assertHas(clean(assertOk(await run(['sessions']))), S, 'sessions'))
  await T('status', async () => assertHas(clean(assertOk(await run(['-s', S, 'status']))), 'taskId', 'status'))
  await SMOKE('profiles', async () => assertOk(await run(['profiles'])))
  await T('ping', async () => assertHas(clean(assertOk(await run(['-s', S, 'ping', '60']))), 'keep-alive', 'ping'))
  await T('narrate', async () => assertHas(clean(assertOk(await run(['-s', S, 'narrate', 'testing']))), 'narrated', 'narrate'))
  await SMOKE('messages', async () => assertOk(await run(['-s', S, 'messages'])))
  await T('run-code', async () => assertHas(clean(assertOk(await run(['-s', S, 'run-code'], { input: "cliLog('RC:' + (await pageInfo()).title)" }))), 'RC:', 'run-code'))
  await SMOKE('install --skills', async () => assertHas(clean(assertOk(await run(['install', '--skills']))), 'installed', 'install'))

  SKIP('handoff', 'interactive — hands control to the user')
  SKIP('takeover', 'interactive — only valid after a handoff')
  SKIP('watch', 'blocks until the user hands control back')

  // ===== Management (gated by "operate your Spaces"; full cleanup) =========
  console.log('\n# Management')
  const mgmtProbe = await run(['space-list'])
  if (mgmtProbe.code === 4 || /user_space_operations_disabled/.test(mgmtProbe.err)) {
    for (const n of ['space-list/create/update/delete/activate/open/tabs', 'focus', 'rules/rule-add/rule-delete',
                     'pins/pin-add/pin-remove', 'bookmarks + bookmark-*', 'group-* + ungroup',
                     'split-*', 'downloads', 'user-space + -U flag']) {
      SKIP(n, 'browser-management disabled (Settings ▸ Developer ▸ Allow agents to operate your Spaces)')
    }
    SKIP('profile-create', 'creates an undeletable profile'); SKIP('profile-rename', 'needs a throwaway profile')
    SKIP('download', 'no active download to control')
  } else {
    let spaceId = null
    const cleanup = { rule: null, pin: null, bmk: null, folder: null }
    try {
      await T('space-list', async () => assertHas(clean(assertOk(await run(['space-list']))), 'Default', 'space-list'))
      await T('focus', async () => assertHas(clean(assertOk(await run(['focus']))), 'spaceName', 'focus'))
      await T('space-create', async () => {
        const r = assertOk(await run(['space-create', `phib-selftest-${Date.now()}`, '--json']), 'space-create')
        spaceId = JSON.parse(r.out).spaceId; assert(spaceId, 'no spaceId returned')
      })
      if (spaceId) {
        await T('space-update', async () => assertOk(await run(['space-update', spaceId, '--name', 'phib-selftest-renamed']), 'space-update'))
        await SMOKE('space-activate', async () => assertOk(await run(['space-activate', spaceId])))
        await T('space-open', async () => assertHas(clean(assertOk(await run(['space-open', spaceId, 'https://example.com']))), 'ok', 'space-open'))
        await T('space-tabs', async () => assertHas(clean(assertOk(await run(['space-tabs', spaceId]))), 'tabId=', 'space-tabs'))
      }
      await T('rule-add + rules', async () => {
        const r = assertOk(await run(['rule-add', spaceId || 'Default', '*.phib-selftest.test', '--json']), 'rule-add')
        cleanup.rule = JSON.parse(r.out).id
        assertHas(clean(await run(['rules'])), 'phib-selftest.test', 'rules')
      })
      await T('rule-delete', async () => { assertOk(await run(['rule-delete', cleanup.rule]), 'rule-delete'); cleanup.rule = null })
      await T('pin-add + pins', async () => {
        const r = assertOk(await run(['pin-add', 'https://example.com', '--title', 'phib-selftest-pin', '--json']), 'pin-add')
        cleanup.pin = JSON.parse(r.out).guid
        assertHas(clean(await run(['pins'])), 'phib-selftest-pin', 'pins')
      })
      await T('pin-remove', async () => { assertOk(await run(['pin-remove', cleanup.pin]), 'pin-remove'); cleanup.pin = null })
      await T('bookmark-add/folder/update/move + bookmarks', async () => {
        const spaceArgs = spaceId ? ['--space', spaceId] : []
        const b = assertOk(await run(['bookmark-add', 'https://example.com', '--title', 'phib-bmk', ...spaceArgs, '--json']), 'bookmark-add')
        cleanup.bmk = JSON.parse(b.out).guid
        const f = assertOk(await run(['bookmark-folder', 'phib-folder', ...spaceArgs, '--json']), 'bookmark-folder')
        cleanup.folder = JSON.parse(f.out).guid
        assertOk(await run(['bookmark-update', cleanup.bmk, '--title', 'phib-bmk-2']), 'bookmark-update')
        assertOk(await run(['bookmark-move', cleanup.bmk, '--folder', cleanup.folder]), 'bookmark-move')
        assertHas(clean(await run(['bookmarks', ...spaceArgs])), 'phib-folder', 'bookmarks')
      })
      await T('bookmark-remove', async () => {
        assertOk(await run(['bookmark-remove', cleanup.folder, '--yes']), 'bookmark-remove folder')  // cascades the moved bmk
        cleanup.bmk = null; cleanup.folder = null
      })

      // Tab groups + split view on the agent Space window (needs 3 tabs).
      const G = 'clitest-layout'
      let targets = []
      await T('layout setup (3 tabs)', async () => {
        assertOk(await run(['-s', G, 'open', 'https://example.com']))
        await run(['-s', G, 'tab-new', 'https://example.org'])
        await run(['-s', G, 'tab-new', 'https://example.net'])
        const t = JSON.parse(assertOk(await run(['-s', G, 'tabs', '--json'])).out)
        targets = t.filter((x) => x.url.startsWith('http')).map((x) => x.targetId)
        assert(targets.length >= 3, `need 3 http tabs, got ${targets.length}`)
      })
      let token = null
      await T('group-create + group-list', async () => {
        const r = assertOk(await run(['-s', G, 'group-create', targets[0], targets[1], '--title', 'grp', '--color', 'blue', '--json']), 'group-create')
        token = JSON.parse(r.out).token
        assertHas(clean(await run(['-s', G, 'group-list'])), token, 'group-list')
      })
      await T('group-update', async () => assertOk(await run(['-s', G, 'group-update', token, '--title', 'grp2', '--collapsed']), 'group-update'))
      await T('group-add', async () => assertOk(await run(['-s', G, 'group-add', token, targets[2]]), 'group-add'))
      await T('group-remove', async () => assertOk(await run(['-s', G, 'group-remove', targets[2]]), 'group-remove'))
      await T('ungroup', async () => assertOk(await run(['-s', G, 'ungroup', token]), 'ungroup'))
      let splitId = null
      await T('split-create + split-list', async () => {
        const r = assertOk(await run(['-s', G, 'split-create', targets[0], targets[1], '--json']), 'split-create')
        splitId = JSON.parse(r.out).splitId
        assertHas(clean(await run(['-s', G, 'split-list'])), splitId, 'split-list')
      })
      await T('split-update', async () => assertOk(await run(['-s', G, 'split-update', splitId, '--ratio', '0.6']), 'split-update'))
      await SMOKE('split-swap', async () => assertOk(await run(['-s', G, 'split-swap', splitId])))
      await T('split-remove', async () => assertOk(await run(['-s', G, 'split-remove', splitId]), 'split-remove'))
      await T('group-create + group-close', async () => {
        const r = assertOk(await run(['-s', G, 'group-create', targets[0], targets[1], '--json']))
        assertOk(await run(['-s', G, 'group-close', JSON.parse(r.out).token]), 'group-close')
      })
      await run(['-s', G, 'close'])

      await SMOKE('downloads', async () => assertOk(await run(['downloads', ...(spaceId ? ['--space', spaceId] : [])])))
      SKIP('download <guid>', 'no active download to control')
      SKIP('profile-create', 'creates an undeletable profile')
      SKIP('profile-rename', 'needs a throwaway profile')

      // user-Space page-driving: heredoc form + the -U global flag.
      if (spaceId) {
        await T('user-space (heredoc)', async () => {
          const r = assertOk(await run(['user-space', spaceId], { input: `await goto(${JSON.stringify(FIXTURE)})\ncliLog('US:' + (await pageInfo()).title)` }), 'user-space')
          assertHas(clean(r), 'US:phib-selftest', 'user-space heredoc')
        })
        await T('-U flag (per-command)', async () => {
          assertOk(await run(['-U', spaceId, 'goto', FIXTURE]), '-U goto')
          const r = assertOk(await run(['-U', spaceId, 'eval', "document.title"]), '-U eval')
          assertHas(clean(r), 'phib-selftest', '-U flag')
        })
      }
    } finally {
      // Management cleanup — best effort, never throws.
      if (cleanup.rule) await run(['rule-delete', cleanup.rule]).catch?.(() => {})
      if (cleanup.pin) await run(['pin-remove', cleanup.pin])
      if (cleanup.folder) await run(['bookmark-remove', cleanup.folder, '--yes'])
      if (cleanup.bmk) await run(['bookmark-remove', cleanup.bmk, '--yes'])
      if (spaceId) await run(['space-delete', spaceId, '--yes'])
    }
  }

  // ===== Dialog ============================================================
  // NOT exercised: opening a modal JS dialog (alert/confirm/prompt) in the
  // HIDDEN agent-Space window wedges the Space in this build — the next
  // ensureAgentSpace fails with create_failed and the window must be recovered
  // by closing its tab. Triggering one from a test would strand a hidden
  // window in the user's browser. The `dialog accept|dismiss` command itself
  // is wired to the browser-level path (dismissDialog) for the cases that CAN
  // be reached; see README "Dialogs".
  console.log('\n# Dialog')
  SKIP('dialog accept/dismiss', 'a modal dialog wedges the hidden agent-Space window in this build — not safe to trigger from a test')

  // ===== Teardown ==========================================================
  console.log('\n# Teardown')
  await T('close', async () => assertHas(clean(assertOk(await run(['-s', S, 'close']))), 'closed', 'close'))
  await SMOKE('close-all', async () => assertOk(await run(['close-all'])))
}

let fatal = null
try { await main() } catch (e) { fatal = e }

// ---------------------------------------------------------------------------
// Summary
const by = (s) => results.filter((r) => r.status === s)
console.log('\n' + '─'.repeat(60))
console.log(`RESULTS: ${by('pass').length} passed · ${by('fail').length} failed · ${by('smoke').length} smoke-fail · ${by('skip').length} skipped · ${results.length} total`)
if (by('fail').length) {
  console.log('\nFAILURES:')
  for (const r of by('fail')) console.log(`  ✗ ${r.name} — ${r.detail}`)
}
if (by('smoke').length) {
  console.log('\nSMOKE (non-fatal):')
  for (const r of by('smoke')) console.log(`  · ${r.name} — ${r.detail}`)
}
if (fatal) { console.log(`\nFATAL: ${fatal.stack || fatal.message}`) }
console.log('─'.repeat(60))
process.exit(fatal || by('fail').length ? 1 : 0)
