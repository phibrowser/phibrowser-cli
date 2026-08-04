// Copyright 2026 Phinomenon Inc.
//
// phi — command-line browser automation for Phi Browser, modeled on
// Microsoft's playwright-cli but backed by Phi's agent Spaces over CDP.
//
// Architecture: Phi Browser itself is the daemon. Every invocation is one
// "round": connect over CDP, bind an execution context via the skill's
// enterContext() (an agent Space by default, or a user Space with -U), run
// one command, print a compact result, dispose. Each command declares a
// single `context` field ('page' | 'agent' | 'app' | 'none') and one
// resolver (resolveContext) turns it plus the flags into the binding.
// Element refs (@N) are CDP backendNodeIds — stable for the element's
// lifetime, so refs printed by one invocation remain valid targets for the
// next. observe() diff baselines persist on disk, so `--diff` and the
// after-action change summaries also work across invocations.

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBrowser, latestRelease, releaseIsUsable } from './install-browser.mjs'
import {
  appStatus, describeApp, DOWNLOAD_URL, isCapableApp, loadHelpers,
  MIN_APP_VERSION, resolveLibDir, SETTINGS_DEEPLINK,
} from './resolve-lib.mjs'
import {
  renderBookmarks, renderCredential, renderCredentialStatus, renderDownloads,
  renderJson, renderObserve, renderPinnedTabs, renderProfiles, renderSpaces,
  renderSpaceTabs, renderSplitViews, renderTabGroups, renderTabs, renderUrlRules,
} from './render.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The name this was invoked as: `phi` normally, `phibrowser` through the
// alias, the script name when run straight from a checkout. Help text and
// error prefixes echo what the user actually typed.
const PROG = (() => {
  const raw = (process.argv[1] || '').split('/').pop().replace(/\.mjs$/, '')
  return raw === 'phibrowser' ? 'phibrowser' : 'phi'
})()

const DEFAULT_SESSION = 'cli'
const DEFAULT_MAX_ELEMENTS = 150

// Optional config: ~/.phibrowser/config.json overridden by ./.phibrowser/
// config.json. Recognized keys: session, profile, persistent, quiet, json,
// max, lib. Flags and env always win over config.
function loadConfig() {
  let cfg = {}
  for (const p of [join(homedir(), '.phibrowser', 'config.json'),
                   join(process.cwd(), '.phibrowser', 'config.json')]) {
    try { cfg = { ...cfg, ...JSON.parse(readFileSync(p, 'utf8')) } } catch {}
  }
  return cfg
}

// ---------------------------------------------------------------------------
// Flag specs

const GLOBAL_FLAGS = {
  session: { type: 'str', short: 's', desc: 'session name = agent Space task id (env: PHIBROWSER_SESSION)' },
  'user-space': { type: 'str', short: 'U', desc: "drive a USER Space's real window instead of the agent Space (name or id)" },
  profile: { type: 'str', desc: 'browser profile for a newly created Space' },
  persistent: { type: 'bool', desc: 'create the Space as a permanent workspace' },
  json: { type: 'bool', desc: 'print raw JSON instead of compact text' },
  quiet: { type: 'bool', short: 'q', desc: 'suppress the after-command page summary' },
  max: { type: 'num', desc: `cap printed elements/lines (default ${DEFAULT_MAX_ELEMENTS})` },
  help: { type: 'bool', short: 'h', desc: 'show help' },
  version: { type: 'bool', short: 'v', desc: 'show version' },
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Shared finishing moves

async function safeObserve(ctx, opts) {
  try { return await ctx.h.observe(opts) } catch { return null }
}

// After an in-page action: settle, then print what changed. An action that
// navigated gets the full new-page map instead — a cross-page "diff" is
// noise, and the new element inventory is the caller's next question anyway.
async function actionDiff(ctx) {
  await ctx.h.waitForLoad({ timeout: 10 }).catch(() => {})
  await ctx.h.wait(0.6)
  let d = await safeObserve(ctx, { diff: true })
  if (d?.navigatedFrom) {
    const full = await safeObserve(ctx, {})
    if (full) full.navigatedFrom = d.navigatedFrom
    d = full ?? d
  }
  return d
}

async function finishAction(ctx, verb, result) {
  if (ctx.flags.json) {
    const diff = ctx.flags.quiet ? null : await actionDiff(ctx)
    ctx.print(renderJson({ ok: true, action: verb, result: result ?? true, ...(diff ? { diff } : {}) }))
    return
  }
  ctx.print(`ok: ${verb}`)
  if (ctx.flags.quiet) return
  const d = await actionDiff(ctx)
  if (d) ctx.print(renderObserve(d, { max: ctx.max }))
}

// After a navigation-ish command: print the new page's full element map —
// it is almost always the caller's next question.
async function finishNav(ctx, note) {
  if (ctx.flags.json) {
    const page = ctx.flags.quiet ? undefined : await safeObserve(ctx, {})
    ctx.print(renderJson({ ok: true, ...(note ? { note } : {}), ...(page ? { page } : {}) }))
    return
  }
  if (note) ctx.print(note)
  if (ctx.flags.quiet) {
    const info = await ctx.h.pageInfo().catch(() => null)
    if (info?.url) ctx.print(`- URL: ${info.url}\n- Title: ${info.title ?? ''}`)
    return
  }
  const res = await safeObserve(ctx, {})
  if (res) ctx.print(renderObserve(res, { max: ctx.max }))
}

function requireArg(args, i, what) {
  if (args[i] === undefined) throw new UsageError(`missing ${what}`)
  return args[i]
}

// Tab args accept a 1-based index from `tabs` output or a raw targetId.
async function resolveTab(ctx, arg) {
  if (arg === undefined) return undefined
  if (/^\d{1,3}$/.test(arg)) {
    const tabs = await ctx.h.listTabs()
    const t = tabs[Number(arg) - 1]
    if (!t) throw new UsageError(`tab index ${arg} out of range (${tabs.length} tabs)`)
    return t.targetId
  }
  return arg
}

// The lib's target grammar takes `loc=css:#x` but observe() prints the bare
// value `loc=css:#x` as one token — an agent may paste just `css:#x`. Bare
// scan-locator prefixes are never valid CSS, so normalizing them is safe.
function normalizeTarget(raw) {
  return /^(css|href|role|xpath):/.test(raw) ? `loc=${raw}` : raw
}

// click/hover accept "x,y" coordinates as well as selector/@ref/loc targets.
function parseTarget(raw) {
  const m = /^(\d+)\s*,\s*(\d+)$/.exec(raw)
  if (m) return { coords: [Number(m[1]), Number(m[2])] }
  return { target: normalizeTarget(raw) }
}

// ---------------------------------------------------------------------------
// Command table

const COMMANDS = []
const cmd = (def) => { COMMANDS.push(def); return def }

// --- session / Space ---

cmd({
  name: 'open', group: 'Session', sig: 'open [url]',
  desc: 'Bind the session Space (creating it if needed), optionally open a URL',
  flags: {
    'new-tab': { type: 'bool', desc: 'force a separate tab (skip blank-tab reuse)' },
    'no-cookies': { type: 'bool', desc: 'skip the automatic cookie-consent pass' },
  },
  context: 'page',
  async run(ctx) {
    const pending = ctx.task?.pendingUserMessages
    if (pending) ctx.print(`! ${pending} pending user message(s) — run \`${PROG} messages\` first`)
    if (ctx.args[0]) {
      await ctx.h.openTab(ctx.args[0], {
        reuseBlank: !ctx.flags['new-tab'],
        acceptCookies: !ctx.flags['no-cookies'],
      })
    }
    await finishNav(ctx)
  },
})

cmd({
  name: 'close', group: 'Session', sig: 'close [-m message] [--fail]',
  desc: 'Complete the session task and close its agent Space',
  flags: {
    message: { type: 'str', short: 'm', desc: 'completion status message' },
    fail: { type: 'bool', desc: 'mark the task failed' },
  },
  context: 'agent', create: false,
  async run(ctx) {
    if (!ctx.task) { ctx.print(`(no active Space for session "${ctx.session}")`); return }
    await ctx.h.complete({ success: !ctx.flags.fail, message: ctx.flags.message, immediate: true })
    ctx.print(ctx.flags.json ? renderJson({ ok: true, closed: ctx.session }) : `ok: Space "${ctx.session}" closed`)
  },
})

cmd({
  name: 'sessions', group: 'Session', sig: 'sessions',
  desc: 'List active agent Spaces (sessions)',
  context: 'app',
  async run(ctx) {
    const tasks = await ctx.h.listAgentSpaces()
    if (ctx.flags.json) { ctx.print(renderJson(tasks)); return }
    if (!tasks.length) { ctx.print('(no active agent Spaces)'); return }
    for (const t of tasks) {
      const cur = t.taskId === ctx.session ? '*' : ' '
      ctx.print(`${cur}${t.taskId}  status=${t.status ?? '?'} ownership=${t.ownership ?? '?'}${t.persistent ? ' persistent' : ''}`)
    }
  },
})

cmd({
  name: 'profiles', group: 'Session', sig: 'profiles',
  desc: 'List browser profiles usable for --profile',
  context: 'app',
  async run(ctx) {
    const profiles = await ctx.h.listProfiles()
    if (ctx.flags.json) { ctx.print(renderJson(profiles)); return }
    for (const p of profiles) {
      ctx.print(`${p.profileId}  "${p.displayName}"${p.agentSpacesAllowed === false ? '  (agents blocked)' : ''}`)
    }
  },
})

cmd({
  name: 'status', group: 'Session', sig: 'status',
  desc: 'One-call digest of the session Space (ownership, tabs, keep-alive)',
  context: 'agent', create: false,
  async run(ctx) {
    if (!ctx.task) { ctx.print(`(no active Space for session "${ctx.session}")`); return }
    ctx.print(renderJson(await ctx.h.spaceStatus()))
  },
})

cmd({
  name: 'ping', group: 'Session', sig: 'ping [seconds=600]',
  desc: 'Extend the Space keep-alive before a deliberate quiet stretch',
  context: 'agent',
  async run(ctx) {
    const s = Number(ctx.args[0] ?? 600)
    await ctx.h.ping(s)
    ctx.print(`ok: keep-alive extended ${s}s`)
  },
})

cmd({
  name: 'narrate', group: 'Session', sig: 'narrate <text>',
  desc: 'Set the overlay status pill / transcript narration line',
  context: 'agent',
  async run(ctx) {
    await ctx.h.narrate(requireArg(ctx.args, 0, 'text') && ctx.args.join(' '))
    ctx.print('ok: narrated')
  },
})

cmd({
  name: 'messages', group: 'Session', sig: 'messages',
  desc: 'Read pending user commands typed in the Agent Transcript console',
  context: 'agent', create: false,
  async run(ctx) {
    if (!ctx.task) { ctx.print(`(no active Space for session "${ctx.session}")`); return }
    ctx.print(renderJson(await ctx.h.readUserMessages()))
  },
})

cmd({
  name: 'handoff', group: 'Session', sig: 'handoff <message> [--wait]',
  desc: 'Hand control to the user (login, captcha, confirmation)',
  flags: {
    wait: { type: 'bool', desc: 'block until the user hands back' },
    timeout: { type: 'num', desc: 'seconds to wait with --wait' },
  },
  context: 'agent',
  async run(ctx) {
    const msg = ctx.args.join(' ')
    if (!msg) throw new UsageError('missing handoff message')
    if (ctx.flags.wait) {
      const r = await ctx.h.handOffAndWait(msg, ctx.flags.timeout ? { timeout: ctx.flags.timeout } : {})
      ctx.print(renderJson(r))
    } else {
      await ctx.h.handOff(msg)
      ctx.print(`ok: handed off — resume after hand-back with \`${PROG} watch\``)
    }
  },
})

cmd({
  name: 'takeover', group: 'Session', sig: 'takeover',
  desc: 'Take control back (only after the user said to continue)',
  context: 'agent',
  async run(ctx) {
    await ctx.h.takeOver()
    ctx.print('ok: agent holds control')
  },
})

cmd({
  name: 'watch', group: 'Session', sig: 'watch [--timeout 3600]',
  desc: 'Block until the user hands control back (hand-back watcher)',
  flags: { timeout: { type: 'num', desc: 'seconds to wait (default 3600)' } },
  context: 'agent',
  async run(ctx) {
    ctx.print(renderJson(await ctx.h.waitForAgentControl({ timeout: ctx.flags.timeout ?? 3600 })))
  },
})

// --- navigation / tabs ---

cmd({
  name: 'goto', group: 'Navigation', sig: 'goto <url>',
  desc: 'Navigate the current tab',
  flags: {
    timeout: { type: 'num', desc: 'seconds for navigate + load (default 25)' },
    'no-cookies': { type: 'bool', desc: 'skip the automatic cookie-consent pass' },
  },
  context: 'page',
  async run(ctx) {
    await ctx.h.goto(requireArg(ctx.args, 0, 'url'), {
      ...(ctx.flags.timeout ? { timeout: ctx.flags.timeout } : {}),
      acceptCookies: !ctx.flags['no-cookies'],
    })
    await finishNav(ctx)
  },
})

cmd({
  name: 'reload', group: 'Navigation', sig: 'reload',
  desc: 'Reload the current tab',
  context: 'page',
  async run(ctx) {
    await ctx.h.js('location.reload()').catch(() => {})
    await ctx.h.waitForLoad().catch(() => {})
    await finishNav(ctx)
  },
})

cmd({
  name: 'back', group: 'Navigation', sig: 'back',
  desc: 'Go back in history',
  context: 'page',
  async run(ctx) {
    await ctx.h.js('history.back()').catch(() => {})
    await ctx.h.waitForLoad().catch(() => {})
    await finishNav(ctx)
  },
})

cmd({
  name: 'forward', group: 'Navigation', sig: 'forward',
  desc: 'Go forward in history',
  context: 'page',
  async run(ctx) {
    await ctx.h.js('history.forward()').catch(() => {})
    await ctx.h.waitForLoad().catch(() => {})
    await finishNav(ctx)
  },
})

cmd({
  name: 'tabs', group: 'Navigation', sig: 'tabs',
  desc: 'List the Space\'s tabs (index, targetId, title, URL)',
  context: 'page',
  async run(ctx) {
    const tabs = await ctx.h.listTabs()
    ctx.print(ctx.flags.json ? renderJson(tabs) : renderTabs(tabs))
  },
})

cmd({
  name: 'tab-new', group: 'Navigation', sig: 'tab-new [url]',
  desc: 'Open a new tab (and switch to it)',
  context: 'page',
  async run(ctx) {
    await ctx.h.openTab(ctx.args[0] ?? 'about:blank', { reuseBlank: false })
    await finishNav(ctx)
  },
})

cmd({
  name: 'tab-select', group: 'Navigation', sig: 'tab-select <index|targetId>',
  desc: 'Switch the driven tab',
  context: 'page',
  async run(ctx) {
    await ctx.h.switchTab(await resolveTab(ctx, requireArg(ctx.args, 0, 'tab')))
    await finishNav(ctx)
  },
})

cmd({
  name: 'tab-close', group: 'Navigation', sig: 'tab-close [index|targetId]',
  desc: 'Close a tab (current tab when omitted)',
  context: 'page',
  async run(ctx) {
    await ctx.h.closeTab(await resolveTab(ctx, ctx.args[0]))
    const tabs = await ctx.h.listTabs()
    ctx.print(ctx.flags.json ? renderJson(tabs) : renderTabs(tabs))
  },
})

// --- observation ---

cmd({
  name: 'snapshot', group: 'Observe', sig: 'snapshot [--text] [--diff] [--within <target>]',
  desc: 'Element map of the current page (@refs to act on); --text for prose',
  flags: {
    text: { type: 'bool', desc: 'prose snapshot (article text) instead of element map' },
    diff: { type: 'bool', desc: 'only what changed since the previous scan' },
    within: { type: 'str', desc: 'scan one subtree (selector/@ref/loc/xpath)' },
    'show-hidden': { type: 'bool', desc: 'include hidden elements' },
    filename: { type: 'str', desc: 'write the snapshot to a file instead of stdout' },
  },
  context: 'page',
  async run(ctx) {
    const opts = {
      ...(ctx.flags.within ? { within: normalizeTarget(ctx.flags.within) } : {}),
      ...(ctx.flags['show-hidden'] ? { showHidden: true } : {}),
      ...(ctx.flags.diff ? { diff: true } : {}),
    }
    let out
    if (ctx.flags.text) {
      out = String(await ctx.h.snapshotText(opts))
    } else {
      const res = await ctx.h.observe(opts)
      out = ctx.flags.json ? renderJson(res)
        : renderObserve(res, { max: ctx.flags.filename ? Infinity : ctx.max })
    }
    if (ctx.flags.filename) {
      const path = resolvePath(ctx.flags.filename)
      // Files leave the process without passing through cliLog — scrub here.
      const scrub = ctx.h.__scrubSessionSecrets ?? ((t) => t)
      writeFileSync(path, scrub(out) + '\n')
      ctx.print(`Snapshot written: ${path} (${out.split('\n').length} lines)`)
      return
    }
    ctx.print(out)
  },
})

cmd({
  name: 'find', group: 'Observe', sig: 'find <text> [--regex]',
  desc: 'Search the page\'s prose snapshot; prints matches with context',
  flags: { regex: { type: 'bool', desc: 'treat the query as a regular expression' } },
  context: 'page',
  async run(ctx) {
    const query = ctx.args.join(' ')
    if (!query) throw new UsageError('missing search text')
    const raw = await ctx.h.snapshotText({ maxChars: 200000 })
    const lines = String(raw).split('\n')
    const begin = lines.findIndex((l) => l.startsWith('--- BEGIN UNTRUSTED'))
    const end = lines.findLastIndex((l) => l.startsWith('--- END UNTRUSTED'))
    const body = begin >= 0 && end > begin ? lines.slice(begin + 1, end) : lines
    const re = ctx.flags.regex ? new RegExp(query, 'i') : null
    const needle = query.toLowerCase()
    const hit = (l) => re ? re.test(l) : l.toLowerCase().includes(needle)
    const blocks = []
    let last = -1
    for (let i = 0; i < body.length; i++) {
      if (!hit(body[i])) continue
      const from = Math.max(i - 2, last + 1)
      const to = Math.min(i + 2, body.length - 1)
      if (blocks.length && from <= last + 1) blocks[blocks.length - 1].to = to
      else blocks.push({ from, to })
      last = to
      if (blocks.length >= 40) break
    }
    if (!blocks.length) { ctx.print(`(no matches for ${JSON.stringify(query)})`); return }
    const out = []
    if (begin >= 0) out.push(lines[begin])
    for (const b of blocks) {
      out.push(...body.slice(b.from, b.to + 1))
      out.push('···')
    }
    out.pop()
    if (begin >= 0) out.push(lines[end])
    ctx.print(out.join('\n'))
  },
})

cmd({
  name: 'screenshot', group: 'Observe', sig: 'screenshot [path]',
  desc: 'Viewport PNG; --annotated adds @ref boxes; --window captures browser chrome',
  flags: {
    annotated: { type: 'bool', desc: 'label interactive elements with their @refs' },
    window: { type: 'bool', desc: 'capture the whole browser window' },
  },
  context: 'page',
  async run(ctx) {
    const path = ctx.args[0]
    const r = ctx.flags.annotated ? await ctx.h.annotatedScreenshot(path)
      : ctx.flags.window ? await ctx.h.screenshotBrowser(path)
      : await ctx.h.screenshot(path)
    ctx.print(renderJson(r))
  },
})

cmd({
  name: 'pdf', group: 'Observe', sig: 'pdf [path]',
  desc: 'Export the current page as PDF',
  context: 'page',
  async run(ctx) { ctx.print(renderJson(await ctx.h.savePdf(ctx.args[0]))) },
})

cmd({
  name: 'archive', group: 'Observe', sig: 'archive [path]',
  desc: 'Save the current page as MHTML',
  context: 'page',
  async run(ctx) { ctx.print(renderJson(await ctx.h.archivePage(ctx.args[0]))) },
})

cmd({
  name: 'eval', group: 'Observe', sig: 'eval <expression> [--on <target>]',
  desc: 'Evaluate JavaScript in the page; --on runs it with a target element as `this`',
  flags: { on: { type: 'str', desc: 'element target — expression sees it as `this`' } },
  context: 'page',
  async run(ctx) {
    const expr = ctx.args.join(' ')
    if (!expr) throw new UsageError('missing expression')
    if (ctx.flags.on) {
      const fnDecl = /^\s*function\b/.test(expr) ? expr : `function () { return (${expr}) }`
      ctx.print(renderJson(await ctx.h.callOnElement(normalizeTarget(ctx.flags.on), fnDecl)))
      return
    }
    ctx.print(renderJson(await ctx.h.js(expr)))
  },
})

cmd({
  name: 'console', group: 'Observe', sig: 'console [--errors]',
  desc: 'The tab\'s console messages (includes pre-round backlog)',
  flags: { errors: { type: 'bool', desc: 'only errors/warnings' } },
  context: 'page',
  async run(ctx) {
    ctx.print(await ctx.h.readConsole({ errors: !!ctx.flags.errors, max: ctx.flags.max ?? 100 }))
  },
})

cmd({
  name: 'requests', group: 'Observe', sig: 'requests [--failed]',
  desc: 'Network requests observed during this round',
  flags: { failed: { type: 'bool', desc: 'only failed requests' } },
  context: 'page',
  async run(ctx) {
    ctx.print(await ctx.h.readNetwork({ failedOnly: !!ctx.flags.failed, max: ctx.flags.max ?? 100 }))
  },
})

cmd({
  name: 'info', group: 'Observe', sig: 'info',
  desc: 'Current tab info (URL, title, open dialog if any)',
  context: 'page',
  async run(ctx) { ctx.print(renderJson(await ctx.h.pageInfo())) },
})

cmd({
  name: 'challenge', group: 'Observe', sig: 'challenge',
  desc: 'Detect a Cloudflare-style challenge on the current page',
  context: 'page',
  async run(ctx) {
    const r = await ctx.h.detectChallenge()
    ctx.print(r ? renderJson(r) : '(no challenge detected)')
  },
})

// --- actions ---

cmd({
  name: 'click', group: 'Act', sig: 'click <target|x,y>',
  desc: 'Click a target (@ref, loc=, CSS, xpath, or "x,y" coordinates)',
  flags: {
    double: { type: 'bool', desc: 'double-click' },
    right: { type: 'bool', desc: 'right button' },
    middle: { type: 'bool', desc: 'middle button' },
  },
  context: 'page',
  async run(ctx) {
    const raw = requireArg(ctx.args, 0, 'target')
    const opts = {
      ...(ctx.flags.double ? { clickCount: 2 } : {}),
      ...(ctx.flags.right ? { button: 'right' } : ctx.flags.middle ? { button: 'middle' } : {}),
    }
    const t = parseTarget(raw)
    const r = t.coords ? await ctx.h.click(t.coords[0], t.coords[1], opts)
      : await ctx.h.click(t.target, opts)
    await finishAction(ctx, `clicked ${raw}`, r)
  },
})

cmd({
  name: 'hover', group: 'Act', sig: 'hover <target|x,y>',
  desc: 'Move the mouse over a target (menus, tooltips)',
  context: 'page',
  async run(ctx) {
    const raw = requireArg(ctx.args, 0, 'target')
    const t = parseTarget(raw)
    const r = t.coords ? await ctx.h.hover(t.coords[0], t.coords[1])
      : await ctx.h.hover(t.target)
    await finishAction(ctx, `hovered ${raw}`, r)
  },
})

cmd({
  name: 'fill', group: 'Act', sig: 'fill <target> <text>',
  desc: 'Fill an input/textarea/select/contenteditable (typed + verified)',
  flags: {
    instant: { type: 'bool', desc: 'set the value in one shot (skip typing pace)' },
    submit: { type: 'bool', desc: 'press Enter afterwards' },
  },
  context: 'page',
  async run(ctx) {
    const target = requireArg(ctx.args, 0, 'target')
    const text = ctx.args.slice(1).join(' ')
    if (!ctx.args[1]) throw new UsageError('missing text')
    await ctx.h.fillInput(normalizeTarget(target), text, { instant: !!ctx.flags.instant })
    if (ctx.flags.submit) await ctx.h.pressKey('Enter')
    await finishAction(ctx, `filled ${target}${ctx.flags.submit ? ' + Enter' : ''}`)
  },
})

cmd({
  name: 'type', group: 'Act', sig: 'type <text>',
  desc: 'Type into the focused element',
  context: 'page',
  async run(ctx) {
    const text = ctx.args.join(' ')
    if (!text) throw new UsageError('missing text')
    await ctx.h.typeText(text)
    await finishAction(ctx, 'typed')
  },
})

cmd({
  name: 'press', group: 'Act', sig: 'press <key>',
  desc: 'Press a key (Enter, Tab, ArrowDown, Escape, a, …)',
  context: 'page',
  async run(ctx) {
    await ctx.h.pressKey(requireArg(ctx.args, 0, 'key'))
    await finishAction(ctx, `pressed ${ctx.args[0]}`)
  },
})

cmd({
  name: 'scroll', group: 'Act', sig: 'scroll [--dy 600] [--dx 0] [--x N] [--y N]',
  desc: 'Scroll the page (positive dy scrolls down)',
  flags: {
    dy: { type: 'num', desc: 'vertical delta (default 600)' },
    dx: { type: 'num', desc: 'horizontal delta' },
    x: { type: 'num', desc: 'pointer x for the wheel event' },
    y: { type: 'num', desc: 'pointer y for the wheel event' },
  },
  context: 'page',
  async run(ctx) {
    const opts = {}
    for (const k of ['dy', 'dx', 'x', 'y']) if (ctx.flags[k] !== undefined) opts[k] = ctx.flags[k]
    await ctx.h.scroll(opts)
    await finishAction(ctx, 'scrolled')
  },
})

cmd({
  name: 'upload', group: 'Act', sig: 'upload <target> <file...>',
  desc: 'Attach files to a file input / dropzone target',
  context: 'page',
  async run(ctx) {
    const target = requireArg(ctx.args, 0, 'target')
    const files = ctx.args.slice(1)
    if (!files.length) throw new UsageError('missing file path(s)')
    await ctx.h.uploadFile(normalizeTarget(target), ...files)
    await finishAction(ctx, `uploaded ${files.length} file(s)`)
  },
})

cmd({
  name: 'dialog', group: 'Act', sig: 'dialog <accept|dismiss> [--text <prompt>]',
  desc: 'Resolve a native dialog (alert/confirm/prompt/beforeunload)',
  flags: {
    text: { type: 'str', desc: 'prompt text to submit with accept' },
    tab: { type: 'str', desc: 'targetId of a non-current tab wedged behind a dialog' },
  },
  context: 'page',
  async run(ctx) {
    const verb = requireArg(ctx.args, 0, 'accept|dismiss')
    if (verb !== 'accept' && verb !== 'dismiss') throw new UsageError('expected accept or dismiss')
    const accept = verb === 'accept'
    // Every dialog the CLI resolves was opened by an EARLIER invocation (each
    // command is its own round), so it is always cross-round: use the
    // browser-level path, which reaches a dialog this round's session never
    // saw open. handleDialog's renderer path would hang on the blocked tab.
    const tabs = ctx.context?.tabs
    const targetId = ctx.flags.tab
      ? await resolveTab(ctx, ctx.flags.tab)
      : (tabs?.find((t) => t.current) ?? tabs?.[0])?.targetId
    if (!targetId) throw new Error('no tab to resolve a dialog on')
    await ctx.h.dismissDialog(targetId, accept, ctx.flags.text)
    await finishAction(ctx, `dialog ${verb}ed`)
  },
})

cmd({
  name: 'accept-cookies', group: 'Act', sig: 'accept-cookies',
  desc: 'Dismiss a cookie-consent banner still covering the page',
  context: 'page',
  async run(ctx) { ctx.print(renderJson(await ctx.h.acceptCookies())) },
})

cmd({
  name: 'viewport', group: 'Act', sig: 'viewport <width> <height>',
  desc: 'Override the tab viewport (responsive testing only)',
  context: 'page',
  async run(ctx) {
    const width = Number(requireArg(ctx.args, 0, 'width'))
    const height = Number(requireArg(ctx.args, 1, 'height'))
    await ctx.h.setViewport({ width, height })
    await finishNav(ctx, `ok: viewport ${width}x${height}`)
  },
})

// --- waiting ---

cmd({
  name: 'wait', group: 'Wait', sig: 'wait [seconds] [--load|--idle|--element <t>|--fn <expr>]',
  desc: 'Wait for time, load, network idle, an element, or a page condition',
  flags: {
    load: { type: 'bool', desc: 'wait for document load' },
    idle: { type: 'bool', desc: 'wait for network idle' },
    element: { type: 'str', desc: 'wait for a target to exist' },
    fn: { type: 'str', desc: 'poll a page JS expression until truthy' },
    'min-count': { type: 'num', desc: 'with --element: wait for ≥N matches' },
    timeout: { type: 'num', desc: 'seconds before giving up' },
  },
  context: 'page',
  async run(ctx) {
    const t = ctx.flags.timeout ? { timeout: ctx.flags.timeout } : {}
    if (ctx.flags.load) { await ctx.h.waitForLoad(t); ctx.print('ok: loaded') }
    else if (ctx.flags.idle) { await ctx.h.waitForNetworkIdle(t); ctx.print('ok: network idle') }
    else if (ctx.flags.element) {
      const r = await ctx.h.waitForElement(normalizeTarget(ctx.flags.element), {
        ...t, ...(ctx.flags['min-count'] ? { minCount: ctx.flags['min-count'] } : {}),
      })
      ctx.print(renderJson(r))
    } else if (ctx.flags.fn) {
      ctx.print(renderJson(await ctx.h.waitForFunction(ctx.flags.fn, t)))
    } else if (ctx.args[0] !== undefined) {
      await ctx.h.wait(Number(ctx.args[0]))
      ctx.print(`ok: waited ${ctx.args[0]}s`)
    } else {
      throw new UsageError('give seconds or one of --load/--idle/--element/--fn')
    }
  },
})

// --- state ---

cmd({
  name: 'state-save', group: 'State', sig: 'state-save <name>',
  desc: 'Export cookies/storage for later restore',
  flags: { 'all-domains': { type: 'bool', desc: 'include every domain, not just open tabs' } },
  context: 'page',
  async run(ctx) {
    const r = await ctx.h.saveState(requireArg(ctx.args, 0, 'name'),
      ctx.flags['all-domains'] ? { allDomains: true } : {})
    ctx.print(renderJson(r))
  },
})

cmd({
  name: 'state-load', group: 'State', sig: 'state-load <name>',
  desc: 'Restore previously saved cookies/storage',
  flags: { 'open-tabs': { type: 'bool', desc: 'reopen the tabs saved with the state' } },
  context: 'page',
  async run(ctx) {
    const r = await ctx.h.loadState(requireArg(ctx.args, 0, 'name'),
      ctx.flags['open-tabs'] ? { openTabs: true } : {})
    ctx.print(renderJson(r))
  },
})

// --- checkable controls ---

const CHECK_PROBE = `function () {
  var role = (this.getAttribute && this.getAttribute('role')) || ''
  var native = this.tagName === 'INPUT' &&
    (this.type === 'checkbox' || this.type === 'radio')
  var aria = /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role)
  return {
    checkable: native || aria,
    checked: native ? !!this.checked : this.getAttribute('aria-checked') === 'true',
  }
}`

async function setChecked(ctx, want) {
  const raw = requireArg(ctx.args, 0, 'target')
  const target = normalizeTarget(raw)
  const before = await ctx.h.callOnElement(target, CHECK_PROBE)
  if (!before?.checkable) {
    throw new Error(`${raw} is not a checkbox/radio/switch (checkable control required)`)
  }
  if (before.checked === want) {
    ctx.print(ctx.flags.json ? renderJson({ ok: true, changed: false, checked: want })
      : `ok: already ${want ? 'checked' : 'unchecked'}`)
    return
  }
  await ctx.h.click(target)
  const after = await ctx.h.callOnElement(target, CHECK_PROBE).catch(() => null)
  if (after && after.checked !== want) {
    throw new Error(`clicked ${target} but it reads ${after.checked ? 'checked' : 'unchecked'} — the control may be disabled or custom`)
  }
  await finishAction(ctx, `${want ? 'checked' : 'unchecked'} ${target}`)
}

cmd({
  name: 'check', group: 'Act', sig: 'check <target>',
  desc: 'Check a checkbox/radio/switch (idempotent, verified by readback)',
  context: 'page',
  async run(ctx) { await setChecked(ctx, true) },
})

cmd({
  name: 'uncheck', group: 'Act', sig: 'uncheck <target>',
  desc: 'Uncheck a checkbox/switch (idempotent, verified by readback)',
  context: 'page',
  async run(ctx) { await setChecked(ctx, false) },
})

cmd({
  name: 'select', group: 'Act', sig: 'select <target> <value>',
  desc: 'Select a dropdown option (value or visible label)',
  context: 'page',
  async run(ctx) {
    const target = requireArg(ctx.args, 0, 'target')
    const value = ctx.args.slice(1).join(' ')
    if (!ctx.args[1]) throw new UsageError('missing option value')
    await ctx.h.fillInput(normalizeTarget(target), value)
    await finishAction(ctx, `selected ${JSON.stringify(value)} in ${target}`)
  },
})

cmd({
  name: 'drag', group: 'Act', sig: 'drag <startTarget> <endTarget>',
  desc: 'Mouse-drag from one target to another (press, glide, release)',
  flags: { steps: { type: 'num', desc: 'interpolated move steps (default 12)' } },
  context: 'page',
  async run(ctx) {
    const startT = requireArg(ctx.args, 0, 'start target')
    const endT = requireArg(ctx.args, 1, 'end target')
    const locate = async (raw) => {
      const t = parseTarget(raw)
      if (t.coords) return { x: t.coords[0], y: t.coords[1] }
      const hit = await ctx.h.waitForElement(t.target, { timeout: 10 })
      if (!hit?.found) throw new Error(`drag: ${raw} not found or not visible`)
      return { x: hit.x, y: hit.y }
    }
    const a = await locate(startT)
    const b = await locate(endT)
    const steps = Math.max(2, ctx.flags.steps ?? 12)
    await ctx.h.mouseEvent('move', a)
    await ctx.h.wait(0.1)
    await ctx.h.mouseEvent('down', { ...a, buttons: 1 })
    for (let i = 1; i <= steps; i++) {
      await ctx.h.mouseEvent('move', {
        x: Math.round(a.x + ((b.x - a.x) * i) / steps),
        y: Math.round(a.y + ((b.y - a.y) * i) / steps),
        buttons: 1,
      })
      await ctx.h.wait(0.03)
    }
    await ctx.h.mouseEvent('up', { ...b, buttons: 0 })
    await finishAction(ctx, `dragged ${startT} -> ${endT}`)
  },
})

// --- raw keyboard / mouse phases ---

function keyModifiers(flags) {
  return (flags.alt ? 1 : 0) | (flags.ctrl ? 2 : 0) |
         (flags.meta ? 4 : 0) | (flags.shift ? 8 : 0)
}

const MODIFIER_FLAGS = {
  alt: { type: 'bool', desc: 'hold Alt/Option' },
  ctrl: { type: 'bool', desc: 'hold Control' },
  meta: { type: 'bool', desc: 'hold Command' },
  shift: { type: 'bool', desc: 'hold Shift' },
}

cmd({
  name: 'keydown', group: 'Act', sig: 'keydown <key>',
  desc: 'Press a key down without releasing (release with keyup)',
  flags: MODIFIER_FLAGS,
  context: 'page',
  async run(ctx) {
    await ctx.h.keyPhase(requireArg(ctx.args, 0, 'key'), 'down',
                         { modifiers: keyModifiers(ctx.flags) })
    ctx.print(`ok: keydown ${ctx.args[0]}`)
  },
})

cmd({
  name: 'keyup', group: 'Act', sig: 'keyup <key>',
  desc: 'Release a key pressed with keydown',
  flags: MODIFIER_FLAGS,
  context: 'page',
  async run(ctx) {
    await ctx.h.keyPhase(requireArg(ctx.args, 0, 'key'), 'up',
                         { modifiers: keyModifiers(ctx.flags) })
    ctx.print(`ok: keyup ${ctx.args[0]}`)
  },
})

cmd({
  name: 'mousemove', group: 'Act', sig: 'mousemove <x> <y>',
  desc: 'Move the mouse to viewport coordinates',
  context: 'page',
  async run(ctx) {
    const x = Number(requireArg(ctx.args, 0, 'x')), y = Number(requireArg(ctx.args, 1, 'y'))
    await ctx.h.mouseEvent('move', { x, y })
    ctx.print(`ok: mouse at (${x}, ${y})`)
  },
})

cmd({
  name: 'mousedown', group: 'Act', sig: 'mousedown [x] [y]',
  desc: 'Press a mouse button (release with mouseup)',
  flags: { right: { type: 'bool', desc: 'right button' }, middle: { type: 'bool', desc: 'middle button' } },
  context: 'page',
  async run(ctx) {
    const x = Number(ctx.args[0] ?? 400), y = Number(ctx.args[1] ?? 300)
    const button = ctx.flags.right ? 'right' : ctx.flags.middle ? 'middle' : 'left'
    await ctx.h.mouseEvent('down', { x, y, button })
    ctx.print(`ok: mousedown ${button} (${x}, ${y})`)
  },
})

cmd({
  name: 'mouseup', group: 'Act', sig: 'mouseup [x] [y]',
  desc: 'Release a mouse button pressed with mousedown',
  flags: { right: { type: 'bool', desc: 'right button' }, middle: { type: 'bool', desc: 'middle button' } },
  context: 'page',
  async run(ctx) {
    const x = Number(ctx.args[0] ?? 400), y = Number(ctx.args[1] ?? 300)
    const button = ctx.flags.right ? 'right' : ctx.flags.middle ? 'middle' : 'left'
    await ctx.h.mouseEvent('up', { x, y, button })
    await finishAction(ctx, `mouseup ${button}`)
  },
})

cmd({
  name: 'mousewheel', group: 'Act', sig: 'mousewheel <dx> <dy>',
  desc: 'Raw wheel event (positive dy scrolls down)',
  flags: { x: { type: 'num', desc: 'pointer x (default 400)' }, y: { type: 'num', desc: 'pointer y (default 300)' } },
  context: 'page',
  async run(ctx) {
    await ctx.h.mouseEvent('wheel', {
      dx: Number(requireArg(ctx.args, 0, 'dx')), dy: Number(requireArg(ctx.args, 1, 'dy')),
      x: ctx.flags.x ?? 400, y: ctx.flags.y ?? 300,
    })
    await finishAction(ctx, 'wheel')
  },
})

// --- highlight ---

cmd({
  name: 'highlight', group: 'Observe', sig: 'highlight [target] [--hide]',
  desc: 'Overlay a visible outline on a target; --hide removes (all, without target)',
  flags: {
    hide: { type: 'bool', desc: 'remove highlight(s) instead of adding' },
    style: { type: 'str', desc: "outline CSS (default '3px solid #ff2d55')" },
  },
  context: 'page',
  async run(ctx) {
    const target = ctx.args[0]
    if (ctx.flags.hide && !target) {
      const n = await ctx.h.js(
        `(() => { const els = document.querySelectorAll('[data-phib-highlight]');
          for (const el of els) { el.style.outline = el.dataset.phibPrevOutline || '';
            delete el.dataset.phibHighlight; delete el.dataset.phibPrevOutline }
          return els.length })()`)
      ctx.print(`ok: removed ${n} highlight(s)`)
      return
    }
    if (!target) throw new UsageError('missing target (or use --hide to clear all)')
    if (ctx.flags.hide) {
      await ctx.h.callOnElement(normalizeTarget(target), `function () {
        this.style.outline = this.dataset.phibPrevOutline || ''
        delete this.dataset.phibHighlight; delete this.dataset.phibPrevOutline }`)
      ctx.print(`ok: highlight removed from ${target}`)
      return
    }
    const style = ctx.flags.style || '3px solid #ff2d55'
    await ctx.h.callOnElement(normalizeTarget(target), `function (style) {
      if (!this.dataset.phibHighlight) this.dataset.phibPrevOutline = this.style.outline || ''
      this.dataset.phibHighlight = '1'
      this.style.outline = style
      this.style.outlineOffset = '2px'
      try { this.scrollIntoView({ block: 'center' }) } catch (e) {} }`, [style])
    ctx.print(`ok: highlighted ${target}`)
  },
})

// --- cookies ---

function cookieLine(c) {
  const flags = [c.httpOnly && 'httpOnly', c.secure && 'secure',
                 c.session && 'session'].filter(Boolean).join(',')
  return `${c.name}=${c.value}  domain=${c.domain} path=${c.path}${flags ? ` [${flags}]` : ''}`
}

async function pageCookies(ctx) {
  const { cookies } = await ctx.h.cdp('Network.getCookies', {})
  return cookies || []
}

cmd({
  name: 'cookies', group: 'Storage', sig: 'cookies [--domain <d>]',
  desc: "List the current page's cookies",
  flags: { domain: { type: 'str', desc: 'only cookies whose domain contains this' } },
  context: 'page',
  async run(ctx) {
    let list = await pageCookies(ctx)
    if (ctx.flags.domain) list = list.filter((c) => (c.domain || '').includes(ctx.flags.domain))
    if (ctx.flags.json) { ctx.print(renderJson(list)); return }
    ctx.print(list.length ? list.map(cookieLine).join('\n') : '(no cookies)')
  },
})

cmd({
  name: 'cookie-get', group: 'Storage', sig: 'cookie-get <name>',
  desc: 'Print one cookie of the current page',
  context: 'page',
  async run(ctx) {
    const name = requireArg(ctx.args, 0, 'cookie name')
    const hit = (await pageCookies(ctx)).filter((c) => c.name === name)
    if (!hit.length) { ctx.print(`(no cookie named ${JSON.stringify(name)})`); return }
    ctx.print(ctx.flags.json ? renderJson(hit) : hit.map(cookieLine).join('\n'))
  },
})

cmd({
  name: 'cookie-set', group: 'Storage', sig: 'cookie-set <name> <value>',
  desc: 'Create or update a cookie (defaults to the current page URL)',
  flags: {
    url: { type: 'str', desc: 'cookie URL (default: current page)' },
    domain: { type: 'str', desc: 'explicit domain instead of --url' },
    path: { type: 'str', desc: 'cookie path (default /)' },
    secure: { type: 'bool', desc: 'Secure attribute' },
    'http-only': { type: 'bool', desc: 'HttpOnly attribute' },
    'expires-days': { type: 'num', desc: 'expiry in days from now (default: session cookie)' },
  },
  context: 'page',
  async run(ctx) {
    const name = requireArg(ctx.args, 0, 'cookie name')
    const value = requireArg(ctx.args, 1, 'cookie value')
    const params = { name, value }
    if (ctx.flags.domain) {
      params.domain = ctx.flags.domain
      params.path = ctx.flags.path || '/'
    } else {
      params.url = ctx.flags.url || (await ctx.h.pageInfo()).url
      if (ctx.flags.path) params.path = ctx.flags.path
    }
    if (ctx.flags.secure) params.secure = true
    if (ctx.flags['http-only']) params.httpOnly = true
    if (ctx.flags['expires-days']) {
      params.expires = Math.round(Date.now() / 1000 + ctx.flags['expires-days'] * 86400)
    }
    const r = await ctx.h.cdp('Network.setCookie', params)
    if (!r?.success) throw new Error(`cookie-set failed for ${name}`)
    ctx.print(`ok: cookie ${name} set`)
  },
})

cmd({
  name: 'cookie-delete', group: 'Storage', sig: 'cookie-delete <name>',
  desc: "Delete a cookie of the current page (all matching domains/paths)",
  flags: { domain: { type: 'str', desc: 'only this domain' } },
  context: 'page',
  async run(ctx) {
    const name = requireArg(ctx.args, 0, 'cookie name')
    const hits = (await pageCookies(ctx)).filter((c) => c.name === name &&
      (!ctx.flags.domain || (c.domain || '').includes(ctx.flags.domain)))
    for (const c of hits) {
      await ctx.h.cdp('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path })
    }
    ctx.print(hits.length ? `ok: deleted ${hits.length} cookie(s) named ${name}` : `(no cookie named ${JSON.stringify(name)})`)
  },
})

cmd({
  name: 'cookie-clear', group: 'Storage', sig: 'cookie-clear',
  desc: "Delete ALL of the current page's cookies (page-scoped — the profile is the user's, so no global clear)",
  context: 'page',
  async run(ctx) {
    const list = await pageCookies(ctx)
    for (const c of list) {
      await ctx.h.cdp('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path })
    }
    ctx.print(`ok: cleared ${list.length} cookie(s) for the current page`)
  },
})

// --- localStorage / sessionStorage ---

function defineStorageCommands(kind) {
  const store = `${kind}Storage`
  cmd({
    name: `${kind}storage-list`, group: 'Storage', sig: `${kind}storage-list`,
    desc: `List ${store} entries of the current origin`,
    context: 'page',
    async run(ctx) {
      const entries = await ctx.h.js(`(() => { const o = {};
        for (let i = 0; i < ${store}.length; i++) { const k = ${store}.key(i); o[k] = ${store}.getItem(k) }
        return o })()`)
      const keys = Object.keys(entries || {})
      if (ctx.flags.json) { ctx.print(renderJson(entries || {})); return }
      ctx.print(keys.length
        ? keys.map((k) => `${k} = ${entries[k]}`).join('\n') : `(${store} is empty)`)
    },
  })
  cmd({
    name: `${kind}storage-get`, group: 'Storage', sig: `${kind}storage-get <key>`,
    desc: `Print one ${store} value`,
    context: 'page',
    async run(ctx) {
      const key = requireArg(ctx.args, 0, 'key')
      const v = await ctx.h.js(`${store}.getItem(${JSON.stringify(key)})`)
      ctx.print(v === null ? `(no ${store} key ${JSON.stringify(key)})` : String(v))
    },
  })
  cmd({
    name: `${kind}storage-set`, group: 'Storage', sig: `${kind}storage-set <key> <value>`,
    desc: `Set a ${store} value`,
    context: 'page',
    async run(ctx) {
      const key = requireArg(ctx.args, 0, 'key')
      const value = ctx.args.slice(1).join(' ')
      if (ctx.args[1] === undefined) throw new UsageError('missing value')
      await ctx.h.js(`${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
      ctx.print(`ok: ${store}[${JSON.stringify(key)}] set`)
    },
  })
  cmd({
    name: `${kind}storage-delete`, group: 'Storage', sig: `${kind}storage-delete <key>`,
    desc: `Remove one ${store} entry`,
    context: 'page',
    async run(ctx) {
      const key = requireArg(ctx.args, 0, 'key')
      await ctx.h.js(`${store}.removeItem(${JSON.stringify(key)})`)
      ctx.print(`ok: ${store}[${JSON.stringify(key)}] removed`)
    },
  })
  cmd({
    name: `${kind}storage-clear`, group: 'Storage', sig: `${kind}storage-clear`,
    desc: `Clear ${store} for the current origin`,
    context: 'page',
    async run(ctx) {
      await ctx.h.js(`${store}.clear()`)
      ctx.print(`ok: ${store} cleared`)
    },
  })
}
defineStorageCommands('local')
defineStorageCommands('session')

// ---------------------------------------------------------------------------
// Credentials — the user's password manager
//
// Three ways to use a vault item, ordered by how far the secret travels:
// cred-fill (app -> page; the CLI never holds it), cred-run (app -> this
// process -> a child's environment), cred-get (app -> the caller's context).
// Prefer them in that order — the doc's rule, and the reason cred-get carries
// friction the other two don't.
//
// Every secret-touching call pops an approve/deny prompt in Phi naming the
// caller, the site, and the KIND of exposure; a remembered grant covers only
// the kind it was approved for, so a denial on cred-get can follow an
// approved cred-fill. TOTP is deliberately unreachable — a 2FA step is the
// user's, via `handoff`. Same Agent-permissions gate as browser management
// (exit 4 when off); a vault that won't serve exits 6.

const CRED_QUERY_FLAGS = {
  username: { type: 'str', desc: 'pick one account when a site has several' },
  id: { type: 'str', desc: 'credentialId — names the vault item directly' },
  search: { type: 'str', desc: 'vault item name (reaches notes/cards/identities/SSH keys)' },
}

// A repeatable list flag also accepts one comma-separated value. Field and
// environment-variable names never contain a comma, so splitting is safe.
const splitList = (values) =>
  (values ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean)

// The vault query every credential command builds: a bare domain positional,
// or --id/--search for items that have no domain (notes, cards, identities,
// SSH keys — domain queries reach logins only). --username narrows a site
// with several accounts; the lib ignores it on the other query kinds, so
// pairing them is refused here rather than silently doing nothing.
function credQuery(ctx, domain) {
  const q = ctx.flags.id ? { id: ctx.flags.id }
    : ctx.flags.search ? { search: ctx.flags.search }
    : domain ? { domain }
    : null
  if (!q) throw new UsageError('give a domain, or --id / --search')
  if (ctx.flags.username) {
    if (!q.domain) throw new UsageError('--username narrows a domain query, not --id/--search')
    q.username = ctx.flags.username
  }
  return q
}

cmd({
  name: 'cred-status', group: 'Credentials', sig: 'cred-status',
  desc: 'Password-manager readiness (ready/locked/logged_out/not_installed)',
  context: 'app',
  async run(ctx) {
    const r = await ctx.h.credentialStatus()
    ctx.print(ctx.flags.json ? renderJson(r) : renderCredentialStatus(r))
  },
})

cmd({
  name: 'cred-fill', group: 'Credentials', sig: 'cred-fill <target> [domain]',
  desc: 'Fill a login field from the vault — Phi fills it, the value never reaches you',
  flags: {
    field: { type: 'str', desc: "'password' (default) or 'username'" },
    'allow-cross-origin': { type: 'bool', desc: 'allow a fill on another site (confirmed SSO portals only)' },
    ...CRED_QUERY_FLAGS,
  },
  context: 'page',
  async run(ctx) {
    const target = requireArg(ctx.args, 0, 'target')
    // "x,y" is coordinates everywhere else here (click/hover), so someone will
    // try it. Say so in those terms — left alone it reaches the lib as a
    // selector and comes back as a puzzling "target not found: 10,10".
    if (parseTarget(target).coords) {
      throw new UsageError('cred-fill needs an element target (@ref, loc=, CSS) — ' +
        'a fill lands in a named field, not at "x,y" coordinates')
    }
    const field = ctx.flags.field ?? 'password'
    if (field !== 'password' && field !== 'username') {
      throw new UsageError(`--field must be 'password' or 'username', got ${JSON.stringify(field)}`)
    }
    const r = await ctx.h.fillCredential(normalizeTarget(target), credQuery(ctx, ctx.args[1]), {
      field,
      ...(ctx.flags['allow-cross-origin'] ? { allowCrossOrigin: true } : {}),
    })
    // No value to echo, by construction: the fill returns {filled, field}.
    await finishAction(ctx, `filled ${field} into ${target} from the vault`, r)
  },
})

cmd({
  name: 'cred-run', group: 'Credentials', sig: 'cred-run [domain] --env VAR=field -- <cmd...>',
  desc: 'Run a command with vault fields in its environment (secrets skip your context)',
  flags: {
    env: { type: 'list', desc: 'VAR=field mapping, repeatable (e.g. PGPASSWORD=password)' },
    'env-all': { type: 'bool', desc: 'inject every present field as PHI_CRED_<FIELD>' },
    cwd: { type: 'str', desc: 'working directory for the command' },
    timeout: { type: 'num', desc: 'seconds before the command is killed (default 120)' },
    ...CRED_QUERY_FLAGS,
  },
  // Bind the session Space only when it already exists: a credential run
  // needs no browser window, but when one is open the transcript should show
  // that the agent used a vault item. Never worth minting a Space for.
  context: 'agent', create: false,
  async run(ctx) {
    // With --id/--search carrying the query, every positional belongs to the
    // command; otherwise the first is the domain. Nothing in the token itself
    // distinguishes a bare domain from a bare command name.
    const byFlag = Boolean(ctx.flags.id || ctx.flags.search)
    const query = credQuery(ctx, byFlag ? undefined : ctx.args[0])
    const command = ctx.args.slice(byFlag ? 0 : 1)
    if (!command.length) {
      throw new UsageError('give the command after `--` (e.g. `-- psql -c "select 1"`)')
    }
    const env = {}
    for (const pair of splitList(ctx.flags.env)) {
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new UsageError(`--env expects VAR=field, got ${JSON.stringify(pair)}`)
      env[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    const r = await ctx.h.runWithCredential(query, command, {
      env,
      ...(ctx.flags['env-all'] ? { envAll: true } : {}),
      ...(ctx.flags.cwd ? { cwd: ctx.flags.cwd } : {}),
      ...(ctx.flags.timeout ? { timeoutSeconds: ctx.flags.timeout } : {}),
    })
    // The lib already scrubbed the secret values out of both streams.
    if (ctx.flags.json) ctx.print(renderJson(r))
    else {
      if (r.stdout) ctx.print(r.stdout.replace(/\n+$/, ''))
      if (r.stderr) ctx.print(r.stderr.replace(/\n+$/, ''))
      if (!r.timedOut && r.code === 0) ctx.print('ok: exit 0')
    }
    // Output first, then the verdict: a failing child is this command
    // failing (exit 1), not a credential problem — the secret was served.
    if (r.timedOut) throw new Error(`command timed out after ${ctx.flags.timeout ?? 120}s`)
    if (r.code !== 0) throw new Error(`command exited ${r.code}`)
  },
})

cmd({
  name: 'cred-get', group: 'Credentials', sig: 'cred-get [domain] --purpose <why>',
  desc: 'REVEAL a vault item to this process — last resort; prefer cred-fill/cred-run',
  flags: {
    purpose: { type: 'str', desc: 'why you need the value — shown in the approval prompt' },
    fields: { type: 'list', desc: 'limit returned fields, repeatable (e.g. username,password)' },
    ...CRED_QUERY_FLAGS,
  },
  context: 'app',
  async run(ctx) {
    // The lib composes the approval prompt's purpose line for fills and runs
    // from what they are about to do. A reveal has nothing to compose it
    // from, so the CLI insists the caller supplies one: the most exposing
    // call should not be the one the user approves with the least to read.
    if (!ctx.flags.purpose) {
      throw new UsageError('--purpose is required — the user approves this reveal by reading it')
    }
    // An empty list is "no filter", not "no fields" — passing [] through would
    // ask the app for nothing and spend an approval on an empty answer.
    const fields = splitList(ctx.flags.fields)
    const cred = await ctx.h.getCredential(credQuery(ctx, ctx.args[0]), {
      purpose: ctx.flags.purpose,
      ...(fields.length ? { fields } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(cred) : renderCredential(cred))
  },
})

// --- power tools ---

cmd({
  name: 'script', group: 'Session', sig: 'script [args...] (script on stdin)',
  desc: 'Raw engine runner — exactly `node <skill>/scripts/runner.mjs`',
  // 'none': the runner loads the helpers itself, so loading them here too
  // would connect a second, pointless CDP client per invocation. Nothing is
  // prepended and nothing is bound — that is the whole point of this command
  // versus run-code, which enters the session's agent Space first.
  context: 'none',
  async run(ctx) {
    const runner = join(resolveLibDir(), '..', 'runner.mjs')
    // Full stdio inheritance, so `phi script <<<'…'`, a heredoc, `< file`,
    // and a pipe all reach the runner byte-for-byte as they would if it were
    // invoked directly — and its exit code comes back untranslated.
    return await new Promise((res) => {
      const child = spawn(process.execPath, [runner, ...ctx.args], { stdio: 'inherit' })
      child.on('exit', (code, signal) => res(signal ? 128 + 15 : code ?? 1))
      child.on('error', (err) => {
        console.error(`${PROG} script: ${err.message}`)
        res(1)
      })
    })
  },
})

cmd({
  name: 'run-code', group: 'Session', sig: 'run-code [--file <f>] (script on stdin)',
  desc: "Run a phi-browser helper script (heredoc body) bound to this session",
  flags: {
    file: { type: 'str', desc: 'read the script from a file instead of stdin' },
    'no-bind': { type: 'bool', desc: "don't prepend enterContext for the session" },
  },
  context: 'app',
  async run(ctx) {
    let src
    if (ctx.flags.file) {
      src = readFileSync(resolvePath(ctx.flags.file), 'utf8')
    } else {
      src = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) src += chunk
    }
    if (!src.trim()) throw new UsageError('empty script (pipe a heredoc or use --file)')
    const script = (ctx.flags['no-bind'] ? ''
      : `await enterContext({ kind: 'agent', name: ${JSON.stringify(ctx.session)} })\n`) + src
    const runner = join(resolveLibDir(), '..', 'runner.mjs')
    const code = await new Promise((res) => {
      const child = spawn(process.execPath, [runner],
                          { stdio: ['pipe', 'inherit', 'inherit'] })
      child.stdin.end(script)
      child.on('exit', (c) => res(c ?? 1))
      child.on('error', () => res(1))
    })
    if (code !== 0) throw new Error(`script exited with code ${code}`)
  },
})

cmd({
  name: 'close-all', group: 'Session', sig: 'close-all',
  desc: 'Complete and close every agent Space this driver can see',
  context: 'app',
  async run(ctx) {
    const tasks = await ctx.h.listAgentSpaces()
    if (!tasks.length) { ctx.print('(no active agent Spaces)'); return }
    let closed = 0
    for (const t of tasks) {
      try {
        await ctx.h.enterContext({ kind: 'agent', name: t.taskId })
        await ctx.h.complete({ success: true, message: 'closed by close-all', immediate: true })
        closed++
      } catch (err) {
        ctx.print(`! could not close ${t.taskId}: ${err?.message || err}`)
      }
    }
    ctx.print(`ok: closed ${closed}/${tasks.length} Space(s)`)
  },
})

// Where each agent keeps its skills, in the order Phi's own Settings ▸
// Developer installer lists them. Pi also wants a companion extension, which
// is what lets an Agent Transcript command wake a live Pi session.
const SKILL_AGENTS = [
  { id: 'claude', label: 'Claude Code', skills: ['.claude', 'skills'] },
  { id: 'codex', label: 'Codex', skills: ['.codex', 'skills'] },
  { id: 'cursor', label: 'Cursor', skills: ['.cursor', 'skills'] },
  { id: 'openclaw', label: 'OpenClaw', skills: ['.openclaw', 'skills'] },
  { id: 'hermes', label: 'Hermes', skills: ['.hermes', 'skills'] },
  { id: 'pi', label: 'Pi', skills: ['.pi', 'agent', 'skills'],
    extensions: ['.pi', 'agent', 'extensions'] },
]

const realOf = (p) => { try { return realpathSync(p) } catch { return null } }
const tildify = (p) => p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p

/**
 * `ln -sfn`: point `dest` at `src`, replacing a link that is already there
 * without ever following it. A REAL directory in the way is left alone unless
 * forced — that is someone's files, not a link this command made.
 */
function linkSkill(src, dest, { force, dryRun }) {
  let existing = null
  try { existing = lstatSync(dest) } catch {}
  if (existing?.isSymbolicLink() && realOf(dest) && realOf(dest) === realOf(src)) {
    return 'current'
  }
  if (existing && !existing.isSymbolicLink() && !force) return 'blocked'
  if (dryRun) return existing ? 'would replace' : 'would link'
  mkdirSync(dirname(dest), { recursive: true })
  if (existing) rmSync(dest, { recursive: true, force: true })
  symlinkSync(src, dest)
  return existing ? 'relinked' : 'linked'
}

/**
 * Links the phi-browser skill — the engine itself, not this CLI's thin
 * command sheet — into each agent's skills directory. A symlink rather than a
 * copy is the whole point: the skill then tracks the Phi Browser build it came
 * from, so updating the app moves every agent forward at once.
 */
function installPhiBrowserSkill(ctx) {
  // Resolved through realpath so agents link at the app bundle itself rather
  // than at another agent's link to it — one hop, and no chain to go stale.
  const skillRoot = realOf(join(resolveLibDir(), '..', '..'))
  if (!skillRoot || !existsSync(join(skillRoot, 'SKILL.md'))) {
    throw new Error('no phi-browser skill found next to the engine' +
      (skillRoot ? ` (looked in ${skillRoot})` : '') +
      ' — update Phi Browser, or point PHIBROWSER_CLI_LIB at a scripts/lib dir.')
  }
  const named = ctx.args.slice(1).map((a) => a.toLowerCase())
  for (const n of named) {
    if (!SKILL_AGENTS.some((a) => a.id === n)) {
      throw new UsageError(`unknown agent ${JSON.stringify(n)} — ` +
        `expected one of: ${SKILL_AGENTS.map((a) => a.id).join(', ')}`)
    }
  }
  // Naming an agent is the intent, so it is installed whether or not it is
  // set up yet. With none named, install only where the agent already lives —
  // otherwise this litters ~ with directories for tools you don't use.
  const targets = SKILL_AGENTS.filter((a) => named.length
    ? named.includes(a.id)
    : existsSync(join(homedir(), ...a.skills.slice(0, -1))))
  if (!targets.length) {
    ctx.print('(no agent directories found — name one explicitly, e.g. ' +
      `\`${PROG} install skill claude\`)`)
    return
  }
  const opts = { force: ctx.flags.force, dryRun: ctx.flags['dry-run'] }
  const lines = []
  let blocked = 0
  for (const agent of targets) {
    const dest = join(homedir(), ...agent.skills, 'phi-browser')
    const state = linkSkill(skillRoot, dest, opts)
    if (state === 'blocked') blocked++
    lines.push(`  ${agent.label.padEnd(12)} ${state.padEnd(13)} ${tildify(dest)}`)
    if (!agent.extensions) continue
    // Pi's companion extension: without it an Agent Transcript command cannot
    // wake a live Pi session, it only queues until the next round.
    const extSrc = join(skillRoot, 'extensions', 'pi')
    if (!existsSync(extSrc)) continue
    const extDest = join(homedir(), ...agent.extensions, 'phi-browser')
    const extState = linkSkill(extSrc, extDest, opts)
    if (extState === 'blocked') blocked++
    lines.push(`  ${''.padEnd(12)} ${extState.padEnd(13)} ${tildify(extDest)}`)
  }
  ctx.print(`${ctx.flags['dry-run'] ? 'dry run' : 'ok'}: phi-browser skill -> ${skillRoot}\n` +
    lines.join('\n'))
  if (targets.some((a) => a.id === 'pi') && !ctx.flags['dry-run']) {
    ctx.print('\nPi: run `/reload` in an already-open session to pick up the extension.')
  }
  if (blocked) {
    console.error(`${PROG} install: ${blocked} destination(s) hold a real directory, ` +
      'not a link — that is your files, so nothing was touched. Inspect them, ' +
      'then re-run with --force to replace.')
    // Asked to install, did not install: a script must not read this as done.
    return 1
  }
}

cmd({
  name: 'install', group: 'Session', sig: 'install skill [agent...] | browser',
  desc: 'Install the phi-browser skill for your agents, or Phi Browser itself',
  flags: {
    browser: { type: 'bool', desc: 'download and install Phi Browser from the official update feed' },
    force: { type: 'bool', desc: 'with `skill`: replace a real directory sitting where the link goes' },
    'dry-run': { type: 'bool', desc: 'report what would happen, change nothing' },
  },
  context: 'none',
  async run(ctx) {
    if (ctx.args[0] === 'skill') return installPhiBrowserSkill(ctx)
    if (ctx.args[0] && ctx.args[0] !== 'browser') {
      throw new UsageError(`unknown install target ${JSON.stringify(ctx.args[0])} ` +
        '— expected `skill` or `browser`')
    }
    if (!ctx.args[0] && !ctx.flags.browser) {
      throw new UsageError('need `skill` or `browser`')
    }
    // The same installer the missing-browser prompt runs, reachable without
    // a TTY so scripts and agents can provision deliberately.
    const release = await latestRelease()
    if (!releaseIsUsable(release)) {
      throw new Error(`the current stable release is ${release.version}, below the ` +
        `${MIN_APP_VERSION} agent control needs — nothing worth installing yet`)
    }
    if (ctx.flags['dry-run']) {
      ctx.print(`would install Phi Browser ${release.version}\n  ${release.url}`)
      return
    }
    const app = await installBrowser({ release, log: (line) => console.error(line) })
    ctx.print(`ok: ${app}`)
  },
})

// ===========================================================================
// Browser management — operates the USER's real browser data (Spaces,
// profiles, URL rules, pinned tabs, bookmarks, tab layout, downloads). These
// are app-level: no agent Space, no control ownership. Gated by Settings ▸
// Developer ▸ "Allow agents to operate your Spaces" — a
// `user_space_operations_disabled` error means the toggle is off.
//
// DESTRUCTIVE ones (space-delete, bookmark-remove on a folder) act only on an
// explicit request — the CLI surfaces them but the caller owns the intent.

const SPACE_FLAG = { space: { type: 'str', desc: 'target a user Space (name or id) instead of the session window' } }

// --- Spaces ---

cmd({
  name: 'space-list', group: 'Manage', sig: 'space-list',
  desc: "List the user's Spaces",
  context: 'app',
  async run(ctx) {
    const spaces = await ctx.h.listSpaces()
    ctx.print(ctx.flags.json ? renderJson(spaces) : renderSpaces(spaces))
  },
})

cmd({
  name: 'space-create', group: 'Manage', sig: 'space-create <name>',
  desc: 'Create a user Space',
  flags: {
    profile: { type: 'str', desc: 'profileId or display name (default: active Space\'s profile)' },
    color: { type: 'str', desc: 'colorHex #RRGGBB' },
    icon: { type: 'str', desc: 'iconName ("phi:phi-icon-N" or "emoji:<hex>")' },
    activate: { type: 'bool', desc: 'also surface it in the focused window' },
  },
  context: 'app',
  async run(ctx) {
    const name = requireArg(ctx.args, 0, 'space name')
    const r = await ctx.h.createSpace(name, {
      ...(ctx.flags.profile ? { profile: ctx.flags.profile } : {}),
      ...(ctx.flags.color ? { colorHex: ctx.flags.color } : {}),
      ...(ctx.flags.icon ? { iconName: ctx.flags.icon } : {}),
      ...(ctx.flags.activate ? { activate: true } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: created Space "${name}" (${r.spaceId})`)
  },
})

cmd({
  name: 'space-update', group: 'Manage', sig: 'space-update <space>',
  desc: 'Rename / recolor / re-icon a Space',
  flags: {
    name: { type: 'str', desc: 'new name' },
    color: { type: 'str', desc: 'colorHex #RRGGBB' },
    icon: { type: 'str', desc: 'iconName' },
  },
  context: 'app',
  async run(ctx) {
    const space = requireArg(ctx.args, 0, 'space')
    if (!ctx.flags.name && !ctx.flags.color && !ctx.flags.icon) {
      throw new UsageError('give at least one of --name / --color / --icon')
    }
    const r = await ctx.h.updateSpace(space, {
      ...(ctx.flags.name ? { name: ctx.flags.name } : {}),
      ...(ctx.flags.color ? { colorHex: ctx.flags.color } : {}),
      ...(ctx.flags.icon ? { iconName: ctx.flags.icon } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: updated ${r.spaceId}${r.settled ? '' : ' (unconfirmed — re-list)'}`)
  },
})

cmd({
  name: 'space-delete', group: 'Manage', sig: 'space-delete <space>',
  desc: 'DESTRUCTIVE: delete a Space (cascades its bookmarks + URL rules)',
  flags: { yes: { type: 'bool', desc: 'confirm the destructive delete' } },
  context: 'app',
  async run(ctx) {
    const space = requireArg(ctx.args, 0, 'space')
    if (!ctx.flags.yes) {
      throw new UsageError(`refusing to delete "${space}" without --yes (this closes its windows and cascade-deletes its bookmarks + URL rules)`)
    }
    const r = await ctx.h.deleteSpace(space)
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: deleted ${r.spaceId}${r.deleted ? '' : ' (unconfirmed — re-list)'}`)
  },
})

cmd({
  name: 'space-activate', group: 'Manage', sig: 'space-activate <space>',
  desc: "Switch the user's focused window to a Space",
  context: 'app',
  async run(ctx) {
    await ctx.h.activateSpace(requireArg(ctx.args, 0, 'space'))
    ctx.print(`ok: activated ${ctx.args[0]}`)
  },
})

cmd({
  name: 'space-open', group: 'Manage', sig: 'space-open <space> <url>',
  desc: "Open a URL as a new tab in a user Space's window",
  flags: { background: { type: 'bool', desc: "don't select the new tab" } },
  context: 'app',
  async run(ctx) {
    const space = requireArg(ctx.args, 0, 'space')
    const url = requireArg(ctx.args, 1, 'url')
    const r = await ctx.h.openSpaceTab(space, url, { activate: !ctx.flags.background })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: opened tab ${r.tabId} in "${space}"`)
  },
})

cmd({
  name: 'space-tabs', group: 'Manage', sig: 'space-tabs <space>',
  desc: "List a user Space's tabs (tabId works as a tab reference)",
  context: 'app',
  async run(ctx) {
    const tabs = await ctx.h.listSpaceTabs(requireArg(ctx.args, 0, 'space'))
    ctx.print(ctx.flags.json ? renderJson(tabs) : renderSpaceTabs(tabs))
  },
})

cmd({
  name: 'focus', group: 'Manage', sig: 'focus',
  desc: 'Where the user is right now (active Space + selected tab)',
  context: 'app',
  async run(ctx) { ctx.print(renderJson(await ctx.h.userFocus())) },
})

// --- Profiles ---

cmd({
  name: 'profile-create', group: 'Manage', sig: 'profile-create <displayName>',
  desc: 'Create a browser profile (own cookies/logins)',
  context: 'app',
  async run(ctx) {
    const name = ctx.args.join(' ')
    if (!name) throw new UsageError('missing display name')
    const r = await ctx.h.createProfile(name)
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: created profile "${name}" (${r.profileId})`)
  },
})

cmd({
  name: 'profile-rename', group: 'Manage', sig: 'profile-rename <profileId> <displayName>',
  desc: 'Rename a profile',
  context: 'app',
  async run(ctx) {
    const id = requireArg(ctx.args, 0, 'profileId')
    const name = ctx.args.slice(1).join(' ')
    if (!name) throw new UsageError('missing new display name')
    await ctx.h.renameProfile(id, name)
    ctx.print(`ok: renamed ${id} -> "${name}"`)
  },
})

// --- URL rules ---

cmd({
  name: 'rules', group: 'Manage', sig: 'rules',
  desc: 'List URL routing rules (ids regenerate on every write — list fresh before edit)',
  context: 'app',
  async run(ctx) {
    const rules = await ctx.h.listUrlRules()
    ctx.print(ctx.flags.json ? renderJson(rules) : renderUrlRules(rules))
  },
})

cmd({
  name: 'rule-add', group: 'Manage', sig: 'rule-add <space> <host>',
  desc: 'Route matching navigations into a Space (host: exact, *.wild, or *contains*)',
  flags: {
    path: { type: 'str', desc: 'pathPrefix to narrow to a subtree' },
    ask: { type: 'bool', desc: 'prompt instead of auto-routing' },
  },
  context: 'app',
  async run(ctx) {
    const space = requireArg(ctx.args, 0, 'space (or "incognito")')
    const host = requireArg(ctx.args, 1, 'host')
    const r = await ctx.h.addUrlRule({
      space, host,
      ...(ctx.flags.path ? { pathPrefix: ctx.flags.path } : {}),
      ...(ctx.flags.ask ? { ask: true } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: rule ${r.id} — ${host} -> ${space}`)
  },
})

cmd({
  name: 'rule-delete', group: 'Manage', sig: 'rule-delete <id>',
  desc: 'Delete a URL rule (get the id from a fresh `rules` in the same run)',
  context: 'app',
  async run(ctx) {
    await ctx.h.deleteUrlRule(requireArg(ctx.args, 0, 'rule id'))
    ctx.print(`ok: rule ${ctx.args[0]} deleted`)
  },
})

// --- Pinned tabs ---

cmd({
  name: 'pins', group: 'Manage', sig: 'pins [--profile <p>]',
  desc: 'List pinned tabs (per-profile)',
  flags: { profile: { type: 'str', desc: 'profileId or name (default: active)' } },
  context: 'app',
  async run(ctx) {
    const tabs = await ctx.h.listPinnedTabs(ctx.flags.profile ? { profile: ctx.flags.profile } : {})
    ctx.print(ctx.flags.json ? renderJson(tabs) : renderPinnedTabs(tabs))
  },
})

cmd({
  name: 'pin-add', group: 'Manage', sig: 'pin-add <url>',
  desc: 'Pin a URL (appears in the sidebar of every window of the profile)',
  flags: {
    title: { type: 'str', desc: 'pinned-tab title' },
    profile: { type: 'str', desc: 'profileId or name' },
    index: { type: 'num', desc: 'position' },
  },
  context: 'app',
  async run(ctx) {
    const url = requireArg(ctx.args, 0, 'url')
    const r = await ctx.h.addPinnedTab(url, {
      ...(ctx.flags.title ? { title: ctx.flags.title } : {}),
      ...(ctx.flags.profile ? { profile: ctx.flags.profile } : {}),
      ...(ctx.flags.index !== undefined ? { index: ctx.flags.index } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: pinned (${r.guid})${r.settled ? '' : ' (unconfirmed)'}`)
  },
})

cmd({
  name: 'pin-remove', group: 'Manage', sig: 'pin-remove <guid>',
  desc: 'Unpin a tab by guid',
  context: 'app',
  async run(ctx) {
    const r = await ctx.h.removePinnedTab(requireArg(ctx.args, 0, 'guid'))
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: unpinned ${ctx.args[0]}`)
  },
})

// --- Bookmarks ---

cmd({
  name: 'bookmarks', group: 'Manage', sig: 'bookmarks [--space <s>]',
  desc: "List a Space's bookmark tree (per-Space)",
  flags: SPACE_FLAG,
  context: 'app',
  async run(ctx) {
    const r = await ctx.h.listBookmarks(ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(ctx.flags.json ? renderJson(r) : renderBookmarks(r.bookmarks))
  },
})

cmd({
  name: 'bookmark-add', group: 'Manage', sig: 'bookmark-add <url>',
  desc: 'Add a bookmark to a Space',
  flags: {
    title: { type: 'str', desc: 'bookmark title' },
    space: { type: 'str', desc: 'target Space (default: default Space)' },
    folder: { type: 'str', desc: 'parent folder guid' },
    index: { type: 'num', desc: 'position' },
  },
  context: 'app',
  async run(ctx) {
    const url = requireArg(ctx.args, 0, 'url')
    const r = await ctx.h.addBookmark(url, {
      ...(ctx.flags.title ? { title: ctx.flags.title } : {}),
      ...(ctx.flags.space ? { space: ctx.flags.space } : {}),
      ...(ctx.flags.folder ? { folder: ctx.flags.folder } : {}),
      ...(ctx.flags.index !== undefined ? { index: ctx.flags.index } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: bookmarked (${r.guid})${r.settled ? '' : ' (unconfirmed)'}`)
  },
})

cmd({
  name: 'bookmark-folder', group: 'Manage', sig: 'bookmark-folder <title>',
  desc: 'Create a bookmark folder',
  flags: {
    space: { type: 'str', desc: 'target Space' },
    parent: { type: 'str', desc: 'parent folder guid' },
    index: { type: 'num', desc: 'position' },
  },
  context: 'app',
  async run(ctx) {
    const title = ctx.args.join(' ')
    if (!title) throw new UsageError('missing folder title')
    const r = await ctx.h.addBookmarkFolder(title, {
      ...(ctx.flags.space ? { space: ctx.flags.space } : {}),
      ...(ctx.flags.parent ? { parent: ctx.flags.parent } : {}),
      ...(ctx.flags.index !== undefined ? { index: ctx.flags.index } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: folder "${title}" (${r.guid})`)
  },
})

cmd({
  name: 'bookmark-update', group: 'Manage', sig: 'bookmark-update <guid>',
  desc: 'Edit a bookmark title/url',
  flags: { title: { type: 'str', desc: 'new title' }, url: { type: 'str', desc: 'new url' } },
  context: 'app',
  async run(ctx) {
    const guid = requireArg(ctx.args, 0, 'guid')
    if (ctx.flags.title === undefined && ctx.flags.url === undefined) {
      throw new UsageError('give --title and/or --url')
    }
    await ctx.h.updateBookmark(guid, {
      ...(ctx.flags.title !== undefined ? { title: ctx.flags.title } : {}),
      ...(ctx.flags.url !== undefined ? { url: ctx.flags.url } : {}),
    })
    ctx.print(`ok: bookmark ${guid} updated`)
  },
})

cmd({
  name: 'bookmark-move', group: 'Manage', sig: 'bookmark-move <guid>',
  desc: 'Move a bookmark into a folder / to an index',
  flags: { folder: { type: 'str', desc: 'destination folder guid (omit for root)' }, index: { type: 'num', desc: 'position' } },
  context: 'app',
  async run(ctx) {
    const guid = requireArg(ctx.args, 0, 'guid')
    await ctx.h.moveBookmark(guid, {
      ...(ctx.flags.folder ? { folder: ctx.flags.folder } : {}),
      ...(ctx.flags.index !== undefined ? { index: ctx.flags.index } : {}),
    })
    ctx.print(`ok: bookmark ${guid} moved`)
  },
})

cmd({
  name: 'bookmark-remove', group: 'Manage', sig: 'bookmark-remove <guid>',
  desc: 'Remove a bookmark (a folder removes its whole subtree — needs --yes)',
  flags: { yes: { type: 'bool', desc: 'confirm removing a folder subtree' } },
  context: 'app',
  async run(ctx) {
    const guid = requireArg(ctx.args, 0, 'guid')
    // A leaf is safe; a folder cascades. We can't cheaply tell which, so
    // require --yes only when the caller hasn't already confirmed intent.
    if (!ctx.flags.yes) {
      throw new UsageError(`removing ${guid} — if it is a folder this deletes its whole subtree. Re-run with --yes to confirm.`)
    }
    const r = await ctx.h.removeBookmark(guid)
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: removed ${guid}`)
  },
})

// --- Tab groups (session window by default, --space for a user Space) ---

cmd({
  name: 'group-list', group: 'Manage', sig: 'group-list [--space <s>]',
  desc: 'List tab groups in the session window (or a user Space)',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    const g = await ctx.h.listTabGroups(ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(ctx.flags.json ? renderJson(g) : renderTabGroups(g))
  },
})

cmd({
  name: 'group-create', group: 'Manage', sig: 'group-create <tab...> [--title T] [--color C]',
  desc: 'Group tabs (targets: @ref/targetId in session window, or tabId with --space)',
  flags: {
    title: { type: 'str', desc: 'group title' },
    color: { type: 'str', desc: 'grey|blue|red|yellow|green|pink|purple|cyan|orange' },
    ...SPACE_FLAG,
  },
  context: 'page',
  async run(ctx) {
    if (!ctx.args.length) throw new UsageError('give at least one tab target')
    const r = await ctx.h.createTabGroup(groupTargets(ctx.args), {
      ...(ctx.flags.title ? { title: ctx.flags.title } : {}),
      ...(ctx.flags.color ? { color: ctx.flags.color } : {}),
      ...(ctx.flags.space ? { space: ctx.flags.space } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: group ${r.token}`)
  },
})

cmd({
  name: 'group-update', group: 'Manage', sig: 'group-update <token>',
  desc: 'Retitle / recolor / collapse a tab group',
  flags: {
    title: { type: 'str', desc: 'new title' },
    color: { type: 'str', desc: 'new color' },
    collapsed: { type: 'bool', desc: 'collapse the group' },
    expanded: { type: 'bool', desc: 'expand the group' },
    ...SPACE_FLAG,
  },
  context: 'page',
  async run(ctx) {
    const token = requireArg(ctx.args, 0, 'group token')
    const opts = { ...(ctx.flags.space ? { space: ctx.flags.space } : {}) }
    if (ctx.flags.title !== undefined) opts.title = ctx.flags.title
    if (ctx.flags.color !== undefined) opts.color = ctx.flags.color
    if (ctx.flags.collapsed) opts.collapsed = true
    if (ctx.flags.expanded) opts.collapsed = false
    await ctx.h.updateTabGroup(token, opts)
    ctx.print(`ok: group ${token} updated`)
  },
})

cmd({
  name: 'group-add', group: 'Manage', sig: 'group-add <token> <tab...>',
  desc: 'Add tabs to a group',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    const token = requireArg(ctx.args, 0, 'group token')
    if (ctx.args.length < 2) throw new UsageError('give at least one tab target')
    await ctx.h.addTabsToGroup(token, groupTargets(ctx.args.slice(1)),
                               ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(`ok: added ${ctx.args.length - 1} tab(s) to ${token}`)
  },
})

cmd({
  name: 'group-remove', group: 'Manage', sig: 'group-remove <tab...>',
  desc: 'Remove tabs from their group (keeps the tabs)',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    if (!ctx.args.length) throw new UsageError('give at least one tab target')
    await ctx.h.removeTabsFromGroup(groupTargets(ctx.args),
                                    ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(`ok: removed ${ctx.args.length} tab(s) from their group`)
  },
})

cmd({
  name: 'ungroup', group: 'Manage', sig: 'ungroup <token>',
  desc: 'Dissolve a group but keep its tabs',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    await ctx.h.ungroupTabGroup(requireArg(ctx.args, 0, 'token'),
                                ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(`ok: ungrouped ${ctx.args[0]}`)
  },
})

cmd({
  name: 'group-close', group: 'Manage', sig: 'group-close <token>',
  desc: 'Close a group AND its tabs',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    await ctx.h.closeTabGroup(requireArg(ctx.args, 0, 'token'),
                              ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(`ok: closed group ${ctx.args[0]} and its tabs`)
  },
})

// --- Split view ---

cmd({
  name: 'split-list', group: 'Manage', sig: 'split-list [--space <s>]',
  desc: 'List split views',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    const v = await ctx.h.listSplitViews(ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(ctx.flags.json ? renderJson(v) : renderSplitViews(v))
  },
})

cmd({
  name: 'split-create', group: 'Manage', sig: 'split-create <tab1> <tab2>',
  desc: 'Show two tabs side by side',
  flags: {
    layout: { type: 'str', desc: "'vertical' (default) or 'horizontal'" },
    ...SPACE_FLAG,
  },
  context: 'page',
  async run(ctx) {
    const [t1, t2] = [requireArg(ctx.args, 0, 'tab1'), requireArg(ctx.args, 1, 'tab2')]
    const [r1, r2] = groupTargets([t1, t2])
    const r = await ctx.h.createSplitView(r1, r2, {
      ...(ctx.flags.layout ? { layout: ctx.flags.layout } : {}),
      ...(ctx.flags.space ? { space: ctx.flags.space } : {}),
    })
    ctx.print(ctx.flags.json ? renderJson(r) : `ok: split ${r.splitId}`)
  },
})

cmd({
  name: 'split-update', group: 'Manage', sig: 'split-update <splitId>',
  desc: 'Change a split ratio / layout',
  flags: {
    ratio: { type: 'num', desc: "first pane's share, 0–1" },
    layout: { type: 'str', desc: "'vertical' or 'horizontal'" },
    ...SPACE_FLAG,
  },
  context: 'page',
  async run(ctx) {
    const id = requireArg(ctx.args, 0, 'splitId')
    const opts = { ...(ctx.flags.space ? { space: ctx.flags.space } : {}) }
    if (ctx.flags.ratio !== undefined) opts.ratio = ctx.flags.ratio
    if (ctx.flags.layout) opts.layout = ctx.flags.layout
    await ctx.h.updateSplitView(id, opts)
    ctx.print(`ok: split ${id} updated`)
  },
})

cmd({
  name: 'split-swap', group: 'Manage', sig: 'split-swap <splitId>',
  desc: 'Swap the two panes of a split',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    await ctx.h.swapSplitView(requireArg(ctx.args, 0, 'splitId'),
                              ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(`ok: split ${ctx.args[0]} swapped`)
  },
})

cmd({
  name: 'split-remove', group: 'Manage', sig: 'split-remove <splitId>',
  desc: 'End a split (keeps both tabs)',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    await ctx.h.removeSplitView(requireArg(ctx.args, 0, 'splitId'),
                                ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(`ok: split ${ctx.args[0]} removed`)
  },
})

// --- Downloads ---

cmd({
  name: 'downloads', group: 'Manage', sig: 'downloads [--space <s>]',
  desc: 'List downloads (per-profile, newest first)',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    const rows = await ctx.h.listDownloads(ctx.flags.space ? { space: ctx.flags.space } : {})
    ctx.print(ctx.flags.json ? renderJson(rows) : renderDownloads(rows))
  },
})

cmd({
  name: 'download', group: 'Manage', sig: 'download <guid> [pause|resume|cancel|remove]',
  desc: 'Show or control one download',
  flags: SPACE_FLAG,
  context: 'page',
  async run(ctx) {
    const guid = requireArg(ctx.args, 0, 'download guid')
    const action = ctx.args[1]
    const spaceOpt = ctx.flags.space ? { space: ctx.flags.space } : {}
    if (!action) { ctx.print(renderJson(await ctx.h.getDownload(guid, spaceOpt))); return }
    const map = {
      pause: 'pauseDownload', resume: 'resumeDownload',
      cancel: 'cancelDownload', remove: 'removeDownload',
    }
    const fn = map[action]
    if (!fn) throw new UsageError(`unknown action "${action}" (pause|resume|cancel|remove)`)
    await ctx.h[fn](guid, spaceOpt)
    ctx.print(`ok: ${action} ${guid}`)
  },
})

// --- User-Space binding (run-code companion) ---

cmd({
  name: 'user-space', group: 'Manage', sig: 'user-space <space> (script on stdin)',
  desc: 'Bind a heredoc script to a USER Space (page helpers drive its real window)',
  flags: {
    file: { type: 'str', desc: 'read the script from a file instead of stdin' },
    'no-create': { type: 'bool', desc: 'fail if the Space does not exist' },
    activate: { type: 'bool', desc: 'surface the Space in the focused window' },
  },
  context: 'app',
  async run(ctx) {
    const space = requireArg(ctx.args, 0, 'space')
    let body
    if (ctx.flags.file) body = readFileSync(resolvePath(ctx.flags.file), 'utf8')
    else {
      body = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) body += chunk
    }
    if (!body.trim()) throw new UsageError('empty script (pipe a heredoc or use --file)')
    const spec = JSON.stringify({
      kind: 'user', space,
      create: !ctx.flags['no-create'], activate: !!ctx.flags.activate,
    })
    const script = `await enterContext(${spec})\n${body}`
    const runner = join(resolveLibDir(), '..', 'runner.mjs')
    const code = await new Promise((res) => {
      const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'inherit', 'inherit'] })
      child.stdin.end(script)
      child.on('exit', (c) => res(c ?? 1))
      child.on('error', () => res(1))
    })
    if (code !== 0) throw new Error(`script exited with code ${code}`)
  },
})

// A tab target for the group/split helpers: bare integers are user-Space
// tabIds (pass through), everything else is a session-window target (@ref,
// targetId, selector) the helpers resolve.
function groupTargets(args) {
  return args.map((a) => (/^\d+$/.test(a) ? Number(a) : normalizeTarget(a)))
}

// ---------------------------------------------------------------------------
// Argv parsing

function flagSpecFor(name, cmdDef) {
  const pools = [GLOBAL_FLAGS, cmdDef?.flags || {}]
  for (const pool of pools) {
    if (pool[name]) return { key: name, ...pool[name] }
    for (const [k, v] of Object.entries(pool)) if (v.short === name) return { key: k, ...v }
  }
  return null
}

export function parseArgv(argv) {
  const flags = {}
  const args = []
  let command = null
  let cmdDef = null
  let literal = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (literal || tok === '-' || !tok.startsWith('-')) {
      if (!command) {
        command = tok
        cmdDef = COMMANDS.find((c) => c.name === tok) || null
      } else args.push(tok)
      continue
    }
    if (tok === '--') { literal = true; continue }
    const eq = tok.indexOf('=')
    const name = tok.slice(tok.startsWith('--') ? 2 : 1, eq >= 0 ? eq : undefined)
    const spec = flagSpecFor(name, cmdDef)
    if (!spec) throw new UsageError(`unknown flag ${tok}${command ? ` for "${command}"` : ''}`)
    if (spec.type === 'bool') {
      if (eq >= 0) throw new UsageError(`flag --${spec.key} takes no value`)
      flags[spec.key] = true
      continue
    }
    let value
    if (eq >= 0) value = tok.slice(eq + 1)
    else {
      value = argv[++i]
      if (value === undefined) throw new UsageError(`flag --${spec.key} needs a value`)
    }
    // 'list' accumulates instead of overwriting, so --env A=x --env B=y both
    // survive; every other type keeps last-wins.
    if (spec.type === 'list') {
      flags[spec.key] = [...(flags[spec.key] ?? []), value]
      continue
    }
    flags[spec.key] = spec.type === 'num' ? Number(value) : value
    if (spec.type === 'num' && Number.isNaN(flags[spec.key])) {
      throw new UsageError(`flag --${spec.key} needs a number`)
    }
  }
  return { command, cmdDef, args, flags }
}

// ---------------------------------------------------------------------------
// Help / version

function version() {
  try { return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version } catch { return '0.0.0' }
}

function flagLines(pool) {
  return Object.entries(pool).map(([k, v]) => {
    const label = `  ${(v.short ? `-${v.short}, ` : '    ') + `--${k}`}${v.type !== 'bool' ? ' <v>' : ''}`
    // Pad to the same column as before, but always keep two spaces: a flag
    // name long enough to fill the column would otherwise butt into its text.
    return `${label.padEnd(24)}  ${v.desc || ''}`
  })
}

function helpText(topic) {
  if (topic) {
    const c = COMMANDS.find((x) => x.name === topic)
    if (!c) return `${PROG}: unknown command "${topic}"`
    const lines = [`${PROG} ${c.sig}`, `  ${c.desc}`]
    if (c.flags) lines.push('', 'Flags:', ...flagLines(c.flags))
    return lines.join('\n')
  }
  const groups = new Map()
  for (const c of COMMANDS) {
    if (!groups.has(c.group)) groups.set(c.group, [])
    groups.get(c.group).push(`  ${c.sig.padEnd(46)} ${c.desc}`)
  }
  const lines = [
    `${PROG} v${version()} — drive Phi Browser from the command line`,
    '',
    `Usage: ${PROG} [-s <session>] <command> [args] [flags]`,
    '',
    'Each session is an agent Space in the running Phi Browser: a hidden window',
    'reusing the user\'s login state, watchable from the Space switcher. Refs',
    '(@N) printed by snapshot/observe stay valid across invocations.',
    '',
    'Add -U/--user-space <name> to any page-driving command (open, goto, click,',
    'fill, snapshot, …) to drive a USER Space\'s real, visible window instead of',
    'the agent Space — an unknown name is created.',
    '',
  ]
  for (const [g, ls] of groups) lines.push(`${g}:`, ...ls, '')
  lines.push('Global flags:', ...flagLines(GLOBAL_FLAGS), '',
    'help <command> shows per-command flags. Env: PHIBROWSER_SESSION,',
    'PHIBROWSER_CLI_LIB (helper lib override).')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main

let helpersRef = null

export async function disposeHelpers() {
  if (helpersRef?.__dispose) await helpersRef.__dispose().catch(() => {})
}

// The single place that turns a command's declared `context` + the context
// flags (-s/--session, -U/--user-space, --persistent, per-command --space)
// into a bound execution context via the skill's enterContext(). Returns the
// context descriptor, or null when the command is app-level (no binding).
//
//   'app'   — no binding; management operates the browser app-wide.
//   'agent' — the session's agent Space. create:false binds only if it already
//             exists (close/status/messages must not mint a Space).
//   'page'  — a bound window: the user Space when -U is given; app-level (no
//             binding, helper uses --space) when the command accepts --space
//             and it is set; the session's agent Space otherwise.
async function resolveContext(h, cmdDef, flags, session) {
  const agentSpec = () => ({
    kind: 'agent', name: session,
    ...(flags.profile ? { profile: flags.profile } : {}),
    ...(flags.persistent ? { persistent: true } : {}),
  })

  switch (cmdDef.context) {
    case 'app':
      return null
    case 'agent':
      if (cmdDef.create === false) {
        const tasks = await h.listAgentSpaces()
        if (!tasks.some((t) => t.taskId === session)) return null  // don't create
      }
      return h.enterContext(agentSpec())
    case 'page':
      if (flags['user-space']) {
        return h.enterContext({ kind: 'user', space: flags['user-space'],
          ...(flags.profile ? { profile: flags.profile } : {}) })
      }
      if (flags.space && cmdDef.flags?.space) return null  // --space → app-level
      return h.enterContext(agentSpec())
    default:
      throw new Error(`command "${cmdDef.name}" has invalid context ${JSON.stringify(cmdDef.context)}`)
  }
}

// ---------------------------------------------------------------------------
// No usable browser (exit 5)
//
// The CLI is a client: with no Phi Browser there is nothing to drive and no
// engine to load. Exit 5 keeps that separate from "the command failed" (1),
// so a driving agent can tell "retrying won't help until a human installs or
// starts the app" from a page-level error.

/**
 * Bundle paths of the Phi Browsers running right now, wherever they live —
 * a dev build under DerivedData counts, and is the one a round would reach.
 * Helper/Sentinel/Updater processes nest their own .app inside the browser's,
 * so match only paths whose bundle is the browser itself.
 */
function runningApps() {
  let ps = ''
  try {
    ps = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 16e6 })
  } catch { return [] }
  const apps = new Set()
  for (const line of ps.split('\n')) {
    // existsSync guards the loose match: bundle names contain spaces, so the
    // path cannot be anchored to a single argv token.
    const m = /^(\/.*?\.app)\/Contents\/MacOS\//.exec(line)
    if (m && /\/Phi( Canary)?\.app$/.test(m[1]) && existsSync(m[1])) apps.add(m[1])
  }
  // $PHIBROWSER_APP pins the app for diagnosis too, exactly as it does for
  // the engine — otherwise another install running nearby answers for it.
  const pinned = process.env.PHIBROWSER_APP?.replace(/\/+$/, '')
  return [...apps].filter((app) => !pinned || app === pinned)
}

// Only offer when a human is plausibly watching. Agents commonly run us under
// a pty (isTTY true, nobody reading), so the ask also self-cancels.
function canPrompt(flags) {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY &&
    !flags.json && !flags.quiet && !process.env.CI && !process.env.PHIBROWSER_NO_PROMPT)
}

// Enter accepts; no answer within the timeout declines. A plain setTimeout
// rather than AbortSignal.timeout(), whose timer is unref'd and so is not
// guaranteed to run the cancel when nothing else holds the loop open.
async function confirm(question, timeoutMs = 20000) {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const answer = await rl.question(question, { signal: ac.signal })
    return /^(y|yes)?$/i.test(answer.trim())
  } catch {
    process.stderr.write('\n')
    return false
  } finally {
    clearTimeout(timer)
    rl.close()
  }
}

/**
 * The one ladder every "cannot drive a browser" path walks, in the order the
 * user has to fix things: install it → update it → start it → enable it.
 * Each rung's advice is wrong for the rungs above it — telling someone on an
 * old build to find a Settings toggle it does not have is the case to avoid.
 *
 * The engine starts Phi itself now (connectBrowser in cdp.mjs), so the last
 * two rungs are narrower than they read: "start it" is reached only when
 * launching was suppressed or failed, and "enable it" only on a build old
 * enough that the toggle still hides the socket. Current builds answer
 * whether or not agent control is on, and the consent prompt they raise
 * turns it on as part of allowing the agent. Both rungs stay because the CLI
 * supports every build from 2.4.0 up.
 */
function diagnoseBrowser() {
  // A running browser is the one a round actually reaches, so judge that one
  // — otherwise a stale old copy in /Applications would indict a current
  // build running from anywhere else.
  const running = runningApps().map(describeApp)
  if (running.length) {
    const capable = running.find(isCapableApp)
    return capable ? { kind: 'enabled', app: capable.app } : { kind: 'outdated', ...running[0] }
  }
  const { app, version, canary, outdated } = appStatus()
  if (!app) return { kind: 'absent' }
  if (outdated) return { kind: 'outdated', app, version }
  return { kind: 'stopped', app, canary }
}

// `open -a <app>` launches that exact bundle; with a url it also routes the
// url to it, which matters while two Phi builds are registered for phi://.
function openMac(args) {
  spawn('open', args, { stdio: 'ignore', detached: true }).unref()
}

/**
 * Ask, then actually do it. Answering yes downloads the release from Phi's
 * own Sparkle feed and installs it after both signature checks pass; the
 * download page is the fallback for every path that cannot get there.
 */
async function offerInstall(d) {
  const verb = d.kind === 'outdated' ? 'Update' : 'Install'
  let release
  try {
    release = await latestRelease()
  } catch (err) {
    console.error(`(could not reach the update feed: ${err.message})`)
    if (await confirm(`\nOpen ${DOWNLOAD_URL} instead? [Y/n] `)) openMac([DOWNLOAD_URL])
    return 5
  }

  // The published release can still be behind what the CLI needs; installing
  // it anyway would hand the user a browser this CLI refuses to drive.
  if (!releaseIsUsable(release)) {
    console.error(`\nThe current stable release is ${release.version}, still below the ` +
      `${MIN_APP_VERSION} that agent control needs — installing it would not help yet.`)
    // Deliberately no download offer here: the link serves this very release,
    // so pointing at it would hand over the build we just refused.
    console.error(`Watch for ${MIN_APP_VERSION} on the stable channel, or ask for a ` +
      'Canary build — it is the prerelease channel and is always ahead.')
    return 5
  }

  if (d.kind === 'outdated' && runningApps().includes(d.app)) {
    console.error(`\nQuit Phi Browser first — it is running and cannot replace itself. ` +
      'Or use Phi ▸ Check for Updates… inside the app.')
    return 5
  }

  if (!await confirm(`\n${verb} Phi Browser ${release.version} now? [Y/n] `)) {
    console.error(`Skipped. ${DOWNLOAD_URL} has the download when you want it.`)
    return 5
  }

  try {
    const app = await installBrowser({ release, log: (line) => console.error(line) })
    console.error('\nNext: just run this again — the CLI starts Phi Browser itself and\n' +
                  'Phi asks you to approve this agent, which turns agent control on.')
    if (await confirm('\nLaunch it now? [Y/n] ')) {
      // A just-installed Phi has a fresh profile: without `-skip-onboarding`
      // it sits at the onboarding window with nothing for CDP to attach to.
      openMac(['-a', app, '--args', '-skip-onboarding'])
    }
    return 5
  } catch (err) {
    console.error(`\n${PROG}: install failed — ${err.message}`)
    if (await confirm(`Open ${DOWNLOAD_URL} to install it yourself? [Y/n] `)) openMac([DOWNLOAD_URL])
    return 5
  }
}

// `detail` is the failure that got us here: the engine load error, or null
// when the engine loaded but no endpoint answered.
async function reportNoBrowser(flags, detail) {
  const d = diagnoseBrowser()

  if (d.kind === 'absent' || d.kind === 'outdated') {
    console.error(`${PROG}: ${d.kind === 'absent'
      ? detail?.message ?? 'Phi Browser is not installed. The CLI drives the app — ' +
        `it needs Phi Browser ${MIN_APP_VERSION}+ (free, macOS): ${DOWNLOAD_URL}`
      : `Phi Browser ${d.version} at ${d.app} is older than ${MIN_APP_VERSION}, ` +
        'which is where agent control begins — this CLI cannot drive it.'}`)
    if (canPrompt(flags)) {
      return await offerInstall(d)
    }
    if (d.kind === 'outdated') {
      console.error(`Update it (Phi ▸ Check for Updates…) or download ${MIN_APP_VERSION}+: ${DOWNLOAD_URL}`)
    }
    return 5
  }

  // An installed, current app that still yielded no engine is a broken or
  // partial bundle — not something the user can fix by toggling anything.
  if (detail?.code === 'phi_engine_missing') {
    console.error(`${PROG}: ${detail.message}`)
    console.error('Looked in:\n' + detail.searched.map((p) => `  - ${p}`).join('\n'))
    return 5
  }

  // Engine loaded, but from a build older than the CLI's surface. Reached
  // only when the version did not already say so (unnumbered dev builds, or
  // an engine pinned via $PHIBROWSER_CLI_LIB).
  if (detail?.code === 'engine_too_old') {
    // Name the build the engine came from, which is not necessarily the one
    // running: with a stale stable installed and Canary running elsewhere,
    // the engine resolves from the stable bundle and that is what to update.
    const from = resolveLibDir()
    console.error(`${PROG}: this Phi Browser's automation engine predates the CLI ` +
      `(no ${detail.missing.join(', ')}) — update ` +
      (/\/Phi Canary\.app\//.test(from) ? 'Phi Canary to a current build.'
        : `Phi Browser to ${MIN_APP_VERSION}+ (Phi ▸ Check for Updates…, or ${DOWNLOAD_URL}).`))
    console.error(`Engine loaded from: ${from}`)
    return 5
  }

  // Not running AND the engine's own launch did not bring it up — it is
  // suppressed (PHI_NO_LAUNCH), or `open` could not start that bundle.
  if (d.kind === 'stopped') {
    console.error(`${PROG}: Phi Browser is installed but would not start.` +
      (process.env.PHI_NO_LAUNCH
        ? ' PHI_NO_LAUNCH is set, so\nthe CLI left it alone — start it yourself, or unset that to let the\nCLI start it.'
        : ` Starting ${d.app} failed —\ntry launching it by hand to see what it says.`))
    if (!process.env.PHI_NO_LAUNCH && canPrompt(flags)
        && await confirm(`\nTry starting ${d.app} again? [Y/n] `)) {
      openMac(['-a', d.app, '--args', '-skip-onboarding'])
      console.error('Launching Phi Browser — retry once it is up.')
    }
    return 5
  }

  // A running, capable build that published no socket predates the always-on
  // endpoint, where the toggle really did gate it. Current builds answer with
  // agent control off and offer to turn it on in the consent prompt, so they
  // never reach here.
  console.error(`${PROG}: Phi Browser is running but published no agent socket.\n` +
    'On this build that means agent control is off — enable Settings ▸ Developer\n' +
    '▸ Remote debugging ▸ "Allow agents to control Phi (CDP)", then approve this\n' +
    'agent when asked. Newer builds ask instead of hiding the endpoint, so\n' +
    'updating Phi removes this step for good.')
  if (canPrompt(flags) && await confirm('\nOpen that Settings page now? [Y/n] ')) {
    openMac(['-a', d.app, SETTINGS_DEEPLINK])
    console.error('Opened Settings ▸ General — the Developer section is there.')
  }
  return 5
}

export async function main(argv) {
  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (err) {
    console.error(`${PROG}: ${err.message}`)
    return 2
  }
  const { command, cmdDef, args, flags } = parsed

  if (flags.version) { console.log(version()); return 0 }
  if (!command || command === 'help' || flags.help) {
    console.log(helpText(command === 'help' ? args[0] : flags.help ? command : undefined))
    return command || flags.help ? 0 : 2
  }
  if (!cmdDef) {
    console.error(`${PROG}: unknown command "${command}" (try \`${PROG} help\`)`)
    return 2
  }

  const cfg = loadConfig()
  if (cfg.lib && !process.env.PHIBROWSER_CLI_LIB) process.env.PHIBROWSER_CLI_LIB = cfg.lib
  for (const k of ['profile', 'persistent', 'quiet', 'json', 'max']) {
    if (flags[k] === undefined && cfg[k] !== undefined) flags[k] = cfg[k]
  }
  const session = flags.session || process.env.PHIBROWSER_SESSION ||
                  cfg.session || DEFAULT_SESSION

  // context 'none' runs before helpers even load (install).
  if (cmdDef.context === 'none') {
    const ctx = { args, flags, session, print: (v) => console.log(v) }
    try {
      // A number means "this exact exit code" — `script` propagates the
      // runner's verbatim, so a heredoc's own failure code survives the trip.
      const code = await cmdDef.run(ctx)
      return typeof code === 'number' ? code : 0
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(`${PROG} ${command}: ${err.message}`)
        return 2
      }
      // `script` needs the engine on disk to have something to run; that
      // failure gets the same install/update ladder as every other path.
      if (err?.code === 'phi_not_installed' || err?.code === 'phi_engine_missing') {
        return await reportNoBrowser(flags, err)
      }
      console.error(`${PROG} ${command}: ${err?.message || err}`)
      return 1
    }
  }

  let h
  try {
    h = helpersRef = await loadHelpers()
  } catch (err) {
    if (err?.code === 'phi_not_installed' || err?.code === 'phi_engine_missing') {
      return await reportNoBrowser(flags, err)
    }
    console.error(`${PROG}: ${err?.message || err}`)
    return 1
  }

  // A pre-2.4.0 Phi still ships an engine — an older one, without the entry
  // points this CLI drives. Probe for them rather than trusting a version
  // string (dev builds report a name), so the user gets "update Phi Browser"
  // instead of a TypeError from the first call.
  const missing = ['enterContext', 'observe'].filter((fn) => typeof h[fn] !== 'function')
  if (missing.length) return await reportNoBrowser(flags, { code: 'engine_too_old', missing })
  const scrub = h.__scrubSessionSecrets ?? ((t) => t)
  const ctx = {
    h, args, flags, session,
    max: flags.max ?? DEFAULT_MAX_ELEMENTS,
    context: null,  // the enterContext() result once bound, else null (app-level)
    task: null,     // the same object when that context is an agent Space
    print: (v) => h.cliLog(typeof v === 'string' ? v : renderJson(v)),
  }

  try {
    ctx.context = await resolveContext(h, cmdDef, flags, session)
    // Back-compat: commands written before ctx.context still read ctx.task
    // (agent-Space handle: pendingUserMessages, tabs, existence checks).
    if (ctx.context?.kind === 'agent') ctx.task = ctx.context
    await cmdDef.run(ctx)
    return 0
  } catch (err) {
    const msg = err?.message || String(err)
    if (err instanceof UsageError) {
      console.error(`${PROG} ${command}: ${msg}`)
      console.error(helpText(command))
      return 2
    }
    // Before the generic report: the engine can only say "endpoint not
    // found" and guess at the toggle. It cannot tell an app that is too old
    // from one that is closed from one with the toggle off — the ladder can,
    // so it replaces that message rather than piling on after it.
    if (/CDP endpoint not found/i.test(msg)) return await reportNoBrowser(flags, null)
    console.error(scrub(`${PROG} ${command}: ${msg}`))
    if (/user is controlling/i.test(msg)) {
      console.error('The user holds control of this Space. Wait for hand-back with ' +
                    `\`${PROG} watch\`, or ask them, then \`${PROG} takeover\`.`)
      return 3
    }
    if (/user_space_operations_disabled/i.test(msg)) {
      console.error('Browser management is off. Enable Settings ▸ Developer ▸ ' +
                    '"Allow agents to operate your Spaces" to manage the user\'s ' +
                    'Spaces/bookmarks/etc. Agent-Space commands are unaffected.')
      return 4
    }
    // The vault refused to serve, and repeating the same call cannot change
    // that — only the user can. Kept apart from a plain failure (1) so an
    // agent stops instead of looping on the approval prompt. Retryable
    // credential errors (ambiguous, origin_mismatch) stay at 1: the caller
    // fixes those itself by narrowing the query or confirming the page.
    if (/credential/i.test(msg) &&
        /(?:^|[\s:])(user_denied|not_ready|locked|logged_out|not_installed|disabled|unavailable)\b/.test(msg)) {
      console.error(/user_denied/.test(msg)
        ? 'The user declined this credential request — their answer to the ' +
          'exposure, not to the task. Do not retry it: ask them, or take a ' +
          'path that needs no secret. Note that grants are per exposure kind, ' +
          `so a denied \`${PROG} cred-get\` can follow an approved \`${PROG} cred-fill\`.`
        : `Password manager not ready — run \`${PROG} cred-status\`, then ask ` +
          'the user to unlock or sign in (Phi ▸ Settings ▸ General).')
      return 6
    }
    return 1
  }
}
