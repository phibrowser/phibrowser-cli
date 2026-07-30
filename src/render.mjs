// Copyright 2026 Phinomenon Inc.
//
// Compact terminal renderers for helper return values. The audience is a
// coding agent reading stdout: one element per line, refs first, no colour.

const trunc = (s, n) => {
  s = String(s)
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const fmtVal = (v) => {
  if (typeof v === 'string') return JSON.stringify(trunc(v, 120))
  return String(v)
}

// '@12 button "Sign in" loc=css:#signin' — the same targeting forms the
// action commands accept, so a printed line pastes straight into `click`.
export function renderElement(e) {
  const parts = [`@${e.ref}`, e.role || 'element']
  if (e.name) parts.push(JSON.stringify(trunc(e.name, 80)))
  for (const k of ['type', 'value', 'href', 'checked', 'disabled']) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') {
      parts.push(`${k}=${fmtVal(e[k])}`)
    }
  }
  if (e.hidden) parts.push('(hidden)')
  if (e.crossOrigin) parts.push('(cross-origin)')
  if (e.loc) parts.push(`loc=${e.loc}`)
  return parts.join(' ')
}

export function renderPageHeader(res) {
  const lines = ['### Page', `- URL: ${res.url}`, `- Title: ${res.title}`]
  if (res.navigatedFrom) lines.push(`- Navigated from: ${res.navigatedFrom}`)
  return lines
}

function renderChanged(c) {
  const deltas = Object.entries(c.changed || {})
    .map(([k, d]) => `${k}: ${fmtVal(d.from ?? '')} -> ${fmtVal(d.to ?? '')}`)
    .join(', ')
  const label = c.name ? ` ${JSON.stringify(trunc(c.name, 60))}` : ''
  return `~ @${c.ref} ${c.role || ''}${label} ${deltas}`.trim()
}

// Renders either shape observe() returns: a full scan ({elements}) or a diff
// ({added, removed, changed, unchanged}).
export function renderObserve(res, { max = Infinity } = {}) {
  if (res.dialog) {
    return `[dialog open: ${JSON.stringify(res.dialog)}]\n` +
           'Page JS is blocked — run `phibrowser dialog accept` or ' +
           '`phibrowser dialog dismiss` first.'
  }
  const lines = renderPageHeader(res)
  if (Array.isArray(res.elements)) {
    if (res.headings?.length) {
      lines.push('', '### Headings')
      for (const h of res.headings.slice(0, 40)) lines.push(h)
      if (res.headings.length > 40) {
        lines.push(`…(${res.headings.length - 40} more headings)`)
      }
    }
    lines.push('', `### Elements (${res.elements.length}${res.truncated ? ` shown, ${res.truncated} more truncated` : ''})`)
    const shown = res.elements.slice(0, max)
    for (const e of shown) lines.push(renderElement(e))
    if (res.elements.length > shown.length) {
      lines.push(`…(${res.elements.length - shown.length} more — rerun with --max ${res.elements.length})`)
    }
    if (res.note) lines.push(`(${res.note})`)
    return lines.join('\n')
  }
  // Diff shape.
  const added = res.added || [], removed = res.removed || [], changed = res.changed || []
  if (!added.length && !removed.length && !changed.length) {
    lines.push(`(no element changes; unchanged: ${res.unchanged ?? '?'})`)
    return lines.join('\n')
  }
  lines.push('', '### Changes')
  for (const e of added.slice(0, max)) lines.push(`+ ${renderElement(e)}`)
  for (const e of removed) {
    lines.push(`- @${e.ref} ${e.role || ''}${e.name ? ' ' + JSON.stringify(trunc(e.name, 60)) : ''}`)
  }
  for (const c of changed) lines.push(renderChanged(c))
  lines.push(`(unchanged: ${res.unchanged ?? 0})`)
  return lines.join('\n')
}

export function renderTabs(tabs) {
  if (!tabs?.length) return '(no tabs)'
  return tabs.map((t, i) => {
    const cur = t.current ? '*' : ' '
    return `${cur}${i + 1}. [${t.targetId}] ${trunc(t.title || '', 60)} — ${trunc(t.url || '', 100)}`
  }).join('\n')
}

export function renderJson(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function renderSpaces(spaces) {
  if (!spaces?.length) return '(no spaces)'
  return spaces.map((s) => {
    const tags = [s.isAgentSpace && 'agent', s.isIncognito && 'incognito',
                  s.isDefault && 'default'].filter(Boolean).join(',')
    return `${s.spaceId}  "${s.name}"  profile=${s.profileId ?? '?'}${tags ? ` [${tags}]` : ''}`
  }).join('\n')
}

export function renderProfiles(profiles) {
  if (!profiles?.length) return '(no profiles)'
  return profiles.map((p) =>
    `${p.profileId}  "${p.displayName}"${p.agentSpacesAllowed === false ? '  (agents blocked)' : ''}`).join('\n')
}

export function renderUrlRules(rules) {
  if (!rules?.length) return '(no URL rules)'
  return rules.map((r) =>
    `${r.id}  ${r.host}${r.pathPrefix ? r.pathPrefix : ''} -> space=${r.spaceId}${r.ask ? ' [ask]' : ''}`).join('\n')
}

export function renderPinnedTabs(tabs) {
  if (!tabs?.length) return '(no pinned tabs)'
  return tabs.map((t) => `${t.guid}  ${trunc(t.title || '', 40)} — ${trunc(t.url || '', 90)}`).join('\n')
}

// Bookmarks come as a tree: folders carry `children`, leaves carry `url`.
export function renderBookmarks(nodes, depth = 0) {
  if (!nodes?.length) return depth === 0 ? '(no bookmarks)' : ''
  const pad = '  '.repeat(depth)
  const lines = []
  for (const n of nodes) {
    if (n.children !== undefined) {
      lines.push(`${pad}📁 ${n.title || '(folder)'}  [${n.guid}]`)
      const sub = renderBookmarks(n.children, depth + 1)
      if (sub) lines.push(sub)
    } else {
      lines.push(`${pad}• ${trunc(n.title || n.url, 50)} — ${trunc(n.url || '', 80)}  [${n.guid}]`)
    }
  }
  return lines.join('\n')
}

export function renderDownloads(rows) {
  if (!rows?.length) return '(no downloads)'
  return rows.map((d) => {
    const pct = d.percentComplete >= 0 ? `${d.percentComplete}%` : '?'
    const state = d.paused ? 'paused' : d.state
    return `${d.guid}  ${state} ${pct}  ${trunc(d.filename || d.targetPath || '', 60)}`
  }).join('\n')
}

export function renderTabGroups(groups) {
  if (!groups?.length) return '(no tab groups)'
  return groups.map((g) => {
    const members = (g.tabs || g.members || []).map((m) => m.tabId ?? m).join(',')
    return `${g.token}  "${g.title || ''}" ${g.color || ''}${g.collapsed ? ' [collapsed]' : ''}  tabs=[${members}]`
  }).join('\n')
}

export function renderSplitViews(views) {
  if (!views?.length) return '(no split views)'
  return views.map((v) => {
    const panes = (v.tabs || v.panes || []).map((m) => m.tabId ?? m).join(' | ')
    return `${v.splitId}  ${v.layout || ''} ratio=${v.ratio ?? '?'}  ${panes}`
  }).join('\n')
}

export function renderSpaceTabs(tabs) {
  if (!tabs?.length) return '(no tabs)'
  return tabs.map((t) => {
    const cur = t.active ? '*' : ' '
    return `${cur}tabId=${t.tabId} target=${t.targetId ?? '-'}  ${trunc(t.title || '', 50)} — ${trunc(t.url || '', 80)}`
  }).join('\n')
}
