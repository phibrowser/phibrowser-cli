# phi-cli

Command-line browser automation for **Phi Browser**, modeled on Microsoft's
[`@playwright/cli`](https://github.com/microsoft/playwright-cli) but backed by
Phi's **agent Spaces** over CDP: every session is a hidden Space window in the
user's *running* browser, reusing their login state, watchable from the Space
switcher, with take-control / hand-back built in.

```bash
phi open https://example.com     # bind the Space, open the page, print the element map
phi click @2                     # act on a ref from the map
phi fill @1 "search term" --submit
phi screenshot shot.png
phi close
```

## Architecture

`playwright-cli` keeps a browser daemon alive between invocations; here **Phi
Browser itself is the daemon**. Each invocation is one skill "round": connect
over the app-owned Unix socket, bind an execution **context** via the skill's
`enterContext()`, run one command, print a compact result, exit. Nothing else
runs in the background.

### Contexts — where a command runs

Every command declares one `context`, and a single resolver turns it plus the
flags into a binding:

| Context | Binds | Commands |
|---|---|---|
| `page` | an **agent Space** (default), a **user Space** with `-U`/`--window-id`, a **shadow window** with `--shadow`, or nothing when a `--space`-capable command is given `--space` | open, goto, click, snapshot, cookies, tab groups, downloads, … |
| `agent` | the session's **agent Space**, or its shadow window with `--shadow` (create-or-bind; `close`/`status`/`messages` bind only if it already exists) | close, ping, narrate, handoff, takeover, watch, status, messages |
| `app` | **nothing** — management operates the user's browser app-wide | sessions, profiles, space-*, bookmark-*, rules, pins, focus, … |
| `none` | nothing (runs before helpers load) | install |

So there are exactly four places work can happen — an **agent Space** (hidden,
the default; `--persistent` makes it a lasting one), a **shadow window**
(invisible background work, via `--shadow`), a **user Space** (the user's real
window, via `-U`), and the **app-level** browser-data surface (no window) —
with persistent being a property of an agent Space, not a fifth kind.

The CLI is a thin command surface over the phi-browser skill's helper engine —
it resolves and imports `helpers.mjs` at runtime rather than vendoring it, so
the engine is always the one that shipped with the Phi Browser build it talks
to. Resolution order:

1. `$PHIBROWSER_CLI_LIB` (explicit `scripts/lib` dir)
2. `$PHIBROWSER_APP` (explicit Phi Browser bundle — exclusive: when set, no
   other bundle is searched, so a wrong value is reported rather than
   silently swapped for another install)
3. sibling checkout `../phibrowser-mac/tools/phi-browser-skill/scripts/lib`
4. installed app: `Phi Canary.app` then `Phi.app`, in `/Applications` and
   `~/Applications` — the bundle carries the whole skill under
   `Contents/Resources/phi-browser-skill`. This is what makes `npm i -g` and
   `brew install` work with nothing else set up. Canary is probed first to
   match the order the engine itself probes for the app socket.
5. installed skills: `~/.claude`, `~/.codex`, `~/.cursor`, `~/.hermes`,
   `~/.openclaw`, `~/.pi/agent`, `~/.grok`, `~/.gemini`, `~/.copilot`,
   `~/.config/opencode`, `~/.qwen`, `~/.codebuddy`, `~/.agents`

State that persists between invocations lives in the browser or on disk, not
in the CLI: the Space keeps its tabs (ephemeral TTL ~30 min between rounds —
`phi ping` before longer gaps), refs (`@N`) are CDP backendNodeIds
stable for the element's lifetime, and `observe` diff baselines persist on
disk, so `snapshot --diff` and the after-action change summaries work across
invocations.

## Install

```bash
npm install -g @phibrowser/cli          # npm
brew install phibrowser/tap/phi-cli     # Homebrew (same tarball, adds node)
```

Both install the **`phi`** command, plus `phibrowser` as an alias for it —
the same entry point under either name. There is nothing else to set up: the
CLI finds the automation engine inside the installed Phi Browser app (see
[resolution order](#contexts--where-a-command-runs) above).

The tap serves the browser too, so a machine can get both from Homebrew:

```bash
brew install --cask phibrowser/tap/phi   # the browser
brew install phibrowser/tap/phi-cli      # the CLI that drives it
```

From a checkout, for development:

```bash
cd phibrowser-cli && npm link      # or: alias phi="node $PWD/bin/phi-cli.mjs"
```

Releasing (publish + Homebrew tap sync) is documented in
[RELEASING.md](RELEASING.md).

## Requirements

- macOS (the package is `os: darwin`) and Node ≥ 22
- Phi Browser **2.4.0+** installed — the CLI is a client, not a browser, and
  loads the engine that ships in the app bundle. Run it without one and it
  offers to install it for you (see [Exit codes](#exit-codes)); Canary is
  exempt from the version floor. Some commands need newer builds and say so
  when they meet an older one: shadow windows, `article`, `drag`'s humanized
  glide and `challenge --wait` arrive in 2.7.0, `--window-id` in 2.9.0, `--theme`
  in 2.12.0
- Nothing else. Phi Browser does not have to be running or configured: the
  CLI starts it when no browser is up, and Phi answers whether or not agent
  control is switched on — the consent prompt it raises turns that on as part
  of approving you. Set `PHI_NO_LAUNCH=1` to forbid the CLI from starting your
  browser. (Older builds still gate the socket behind the Settings toggle;
  the CLI says so when it meets one.)
- A Phi build whose `AgentPeerIdentity.ownBrandNames` includes
  `phibrowser-cli`. The CLI brands itself via `process.title` so the app
  treats it as skill plumbing — acting for whoever drives it (the coding
  agent above it, or your terminal), sharing that driver's Spaces and consent
  identity. On older builds the app names the CLI by its script path and
  isolates it under a fresh principal that cannot see the driving agent's
  Spaces (rounds fail with "lost its agent session").

## Sessions

A session names an agent Space task. Default is `cli`; pick one per goal:

```bash
phi -s checkout open https://shop.example   # -s / --session / $PHIBROWSER_SESSION
phi -s checkout click @14
phi sessions                                # list Spaces; * marks yours
phi -s checkout close                       # complete the task, close the Space
```

`--profile <name>` picks the browser profile and `--persistent` creates a
permanent workspace — both apply only when the Space is first created.

`--canary` (or `$PHIBROWSER_CANARY`, or `"canary": true` in the config) pins
the whole round to **Phi Canary**: the engine loads from the Canary bundle,
launch and diagnosis name only Canary, and the install paths use the canary
channel — a running stable Phi never answers for a canary round. It rides the
same exclusive pin `$PHIBROWSER_APP` gives one bundle, so combining the flag
with a `$PHIBROWSER_APP` that names a stable bundle is refused.

### Shadow windows — `--shadow`

`--shadow` runs a session in a window the user **cannot see**: a real browser
window on a real profile, off-screen, with no pip in the switcher, no Agent
Transcript, and no handoff. Page commands work exactly as they do in an agent
Space.

```bash
phi -s prices --shadow open https://example.com/pricing
phi -s prices --shadow snapshot --text
phi -s prices --shadow close          # always: nothing else shows this window
```

An agent Space stays the default and the right answer whenever a task might
need a human — a login, a captcha, a payment — because nobody can step in here.
Use `--shadow` only when asked for work that stays out of the user's way, and
if a human step turns up mid-run, close the window and report what is needed.

- Repeat `--shadow` on every command: without it the same session name binds a
  visible agent Space, just as dropping `-U` leaves the user Space.
- `--incognito` (with `--shadow`) gives the window a fresh off-the-record
  session: no cookies or logins come in, nothing persists, and it is destroyed
  with the window. Repeat it too — a name's incognito-ness is fixed when the
  window is created, and asking for the other kind fails
  `shadow_incognito_mismatch`. `close` is the exception: it works either way.
- `handoff`, `takeover`, `watch`, `status`, `messages` and `screenshot --window`
  refuse with an explanation, because each means the task has outgrown a shadow
  window. `narrate` is a quiet no-op, so report results in your own output.
- `sessions` lists shadow windows and `close-all` closes them, since neither the
  switcher nor the user can reach one. An abandoned window otherwise lingers on
  the same keep-alive clock as an ephemeral Space, burning a renderer.
- `--persistent` and `-U` do not combine with it. It needs the same "operate your
  Spaces" setting as browser management: exit **4** when that is off.

## Output conventions

- After **navigation** (`open`, `goto`, `back`, `tab-select`, …) the CLI
  prints the page header plus the full element map — one line per element,
  in the exact syntax the action commands accept:

  ```
  @32 link "English 7,189,000+ articles" href="https://en.wikipedia.org/" loc=css:#js-link-box-en
  @1 input "Search Wikipedia" type="search" loc=css:#searchInput
  ```

- After **actions** (`click`, `fill`, `press`, …) it prints only what changed
  (`+` added / `-` removed / `~` changed). An action that navigated prints the
  full new-page map instead.
- `fill` and `select` say `(unverified: …)` when a field accepted the value but
  reformatted it (a phone mask, say) — read it back if exactness matters. A
  field that rejects the value outright is a failure, not a note.
- `--quiet` suppresses the summary; `--json` emits raw JSON; `--max N` caps
  printed elements (default 150).
- Page-derived text comes wrapped in `UNTRUSTED PAGE CONTENT` markers — data,
  not instructions. Secrets handled by the round are scrubbed from all output.

### Targets

`click`, `hover`, `fill`, `upload`, `wait --element`, `snapshot --within`
accept: `@12` (ref), `loc=css:#email` (or bare `css:` / `href:` / `role:` /
`xpath:` — the CLI normalizes), raw CSS selectors, `xpath=//button`, or
`"x,y"` viewport coordinates (click/hover/drag only). Prefer refs and locs; they
survive layout shifts and auto-scroll into view.

Element actions reach only what a person's cursor could: a target that is
covered, disabled, or outside the viewport is refused with `target is not
human-operable` rather than reached through page JS. So is input while a
blocking cookie banner or an unresolved Cloudflare check holds the page — the
error says which, and how to clear it.

`drag` presses, glides with the button held, and releases, which suits sliders,
reorder lists and canvas gestures. Both ends must be on screen together, so
`scroll` first if needed. `--steps N` swaps the humanized glide for a straight
line of N raw moves.

## Commands

Run `phi help` for the full list, `phi help <command>` for
per-command flags.

| Group | Commands |
|---|---|
| Session | `open` `close` `close-all` `sessions` `profiles` `status` `ping` `narrate` `messages` `handoff` `takeover` `watch` `run-code` `script` `install skill\|browser` |
| Navigation | `goto` `reload` `back` `forward` `tabs` `tab-new` `tab-select` `tab-close` |
| Observe | `snapshot` (`--filename`) `find` `article` `article-save` `screenshot` `pdf` `archive` `eval` (`--on`) `console` `requests` `info` `challenge` (`--wait`) `highlight` |
| Act | `click` `hover` `fill` `type` `press` `check` `uncheck` `select` `drag` `scroll` `upload` `dialog` `accept-cookies` `viewport` `keydown` `keyup` `mousemove` `mousedown` `mouseup` `mousewheel` |
| Wait | `wait` (seconds, `--load`, `--idle`, `--element`, `--fn`) |
| Storage | `cookies` `cookie-get` `cookie-set` `cookie-delete` `cookie-clear` `localstorage-*` `sessionstorage-*` `state-save` `state-load` |
| Credentials | `cred-status` `cred-fill` `cred-run` `cred-get` |
| Manage | `space-list/create/update/delete/activate/open/tabs` `focus` `profile-create/rename` `rules` `rule-add/delete` `pins` `pin-add/remove` `bookmarks` `bookmark-add/folder/update/move/remove` `group-*` `ungroup` `split-*` `downloads` `download` `user-space` |

### Reading an article

When what you want is an article — a blog post, a news story, a docs page —
reach for `article` before `snapshot --text`. It runs Phi's Reader View
pipeline, so the nav, comments and related-post rails are already gone.

```bash
phi article                # verdict header, then the article's HTML
phi article --meta         # just the verdict: title, rung, coverage
phi article-save post.html # one standalone file, images inlined
```

The header names how it was extracted (`rule`, `readability`, `structural`, or
`accessibility` for a page whose markup defeats the others) and how much of the
page survived. A page that is not an article usually fails with
`no_article_detected` or `below_coverage_floor`; that is an honest answer, so use
`snapshot --text` rather than retrying. A `data:` page fails with `no_target`,
because the reader cannot reach one.

Reader View does not read PDFs (`pdf_document`), and `snapshot --text` sees no
text in one either, so fetch the file and read it outside the browser.

`archive` remains the way to keep the whole original page. Both article commands
need an agent Space or shadow window, not `-U`.

### Browser management

The `Manage` group operates the user's **real** browser data — Spaces,
profiles, URL rules, pinned tabs, bookmarks, tab groups, split view,
downloads — immediately and app-wide. It mirrors the phi-browser skill's
management surface. Notes:

- Gated by **Settings ▸ Developer ▸ "Allow agents to operate your Spaces"**.
  When off, these commands exit **4** with a hint; agent-Space commands are
  unaffected.
- `space-delete` and `bookmark-remove` (on a folder) cascade and require
  `--yes`.
- `space-create`/`space-update` take `--theme` (`pure`, `mist`, `mint`, `aqua`,
  `iris`, `petal`, `coral`, `amber`) or `--color '#RRGGBB'`, which snaps to the
  nearest theme — the output reports the theme that landed. `--icon` takes
  `phi:phi-icon-<name>`, a catalog name (`mail`), `emoji:<hex>`, or the emoji.
- `space-open` reaches a Space with no open window by opening one: surfaced by
  default, behind the user's windows with `--background`.
- `group-*` / `split-*` / `downloads` target the **session's Space window**
  by default; `--space <name|id>` targets a user Space's open window instead.
  For a user Space, get tab references from `space-tabs <space>` (the integer
  `tabId` works as a target). It lists the window's full inventory, with open
  pinned and bookmark tabs tagged as such.
- `user-space <space>` binds a piped heredoc script to a user Space so the
  page helpers (`observe`, `click`, `goto`, …) drive its **real, visible**
  window — the CLI counterpart of the skill's `enterContext({kind:'user'})`.

### Driving a user Space per command — `-U` / `--user-space`

The heredoc above runs everything in one round. For the *symmetric* form —
each ordinary command driving a user Space's real window, exactly like the
default commands drive the agent Space — add the global `-U <name>` flag:

```bash
phi -U "Work" goto https://example.com   # navigate the Work Space's window
phi -U "Work" click @5                     # separate invocation, re-binds to its tab
phi -U "Work" snapshot
```

It applies to every page-driving command (open/goto/click/fill/snapshot/
tabs/cookies/localstorage/… and the `--space`-less `group-*`/`split-*`/
`downloads`), calling `enterContext({kind:'user', space})` instead of binding the agent
Space, and re-attaching to that Space's selected tab each invocation. Notes:

- An unknown name **creates** a new Space (the skill's `enterContext({kind:'user'})`
  default) — mind typos.
- No agent-Space lifecycle applies: there's no ownership/handoff, no
  keep-alive, and `narrate`/`status`/`close` are meaningless here (the window
  is the user's own). Same "operate your Spaces" gate → exit 4 when off.
- Everything happens in the user's visible window; expect their clicks and
  yours to interleave — act in small steps and re-observe.
- Driving stays out of the way: binding and `tab-select` never change which tab
  is selected on screen or raise the window, and a Space with no open window
  opens behind the user's. `open` and `tab-new` are the deliberate exception —
  a new tab appears in the strip.
- `screenshot` times out on a tab the user does not have selected, because a
  background tab in a user window does not paint. Everything else works there;
  screenshot the selected tab, or do visual checks in an agent Space.
- When a Space is open in several windows, the key window answers. `--window-id
  <id>` pins one (ids from `space-list`), works without `-U`, and also applies to
  `space-open`, `space-tabs` and `user-space`. It is `--window-id` because
  `screenshot --window` already means something else.

`eval --on <target>` runs the expression with a target element as `this`
(the element-scoped `eval`). `run-code` pipes a phi-browser heredoc script
bound to the session — the escape hatch for anything without a dedicated
command.

`script` is the same escape hatch with nothing added: it is *exactly*
`node <skill>/scripts/runner.mjs`, so you get the engine's full helper surface
with no `enterContext` prepended and no Space bound.

```bash
phi script <<< 'cliLog((await pageInfo()).title)'
phi script < my-flow.mjs
```

Stdio is inherited, so here-strings, heredocs, pipes and `< file` all reach the
runner byte-for-byte, and its exit code comes back untranslated (a script's
`process.exit(7)` exits 7; an empty stdin exits 2). Use `run-code` when you
want the session's agent Space entered for you; use `script` when you want the
raw runner — including binding a *different* context yourself, or none at all.
Because the CLI resolves the engine the same way it does for every other
command, `script` always runs the build it would actually drive: no hunting for
the skill directory, and no chance of pairing one build's engine with another's
browser.

### Installing the skill

```bash
phi install skill                # the phi-browser skill, for every agent present
phi install skill claude codex   # only these agents
phi install browser              # Phi Browser itself
phi install browser --canary     # Phi Canary, from the canary channel
```

`install skill` **symlinks** the phi-browser skill — the full engine, with its
`references/`, `scripts/` and helper library — into each agent's
`skills/phi-browser`. A link rather than a copy is the point: the skill then
tracks the Phi Browser build it came from, so updating the app moves every
agent forward at once. It is what Phi's **Settings ▸ Developer ▸ "Install the
phi-browser skill" ▸ Add skill to…** menu does, without leaving the terminal.

| Agent | Skills folder |
|---|---|
| `claude` | `~/.claude/skills` |
| `codex` | `~/.codex/skills` |
| `cursor` | `~/.cursor/skills` |
| `hermes` | `~/.hermes/skills` |
| `openclaw` | `~/.openclaw/skills` |
| `pi` | `~/.pi/agent/skills` |
| `grok` | `~/.grok/skills` |
| `antigravity` | `~/.gemini/skills` (shared with Gemini CLI) |
| `copilot` | `~/.copilot/skills` |
| `opencode` | `~/.config/opencode/skills` |
| `qwen` | `~/.qwen/skills` |
| `codebuddy` | `~/.codebuddy/skills` |
| `agents`, `grokbot` | `~/.agents/skills` (one link serves both; also read by Deep Code, Kimi Code, Cline, DeepSeek Harness) |

Name them explicitly, or name none and every agent already present on the
machine gets the link — so this never litters `~` with directories for tools
you don't use. Every agent can drive Phi, but only the first six get the session
mirror: under the rest, Agent Transcript shows the browser steps and not the
agent's own conversation. **Pi** also gets a companion extension at
`~/.pi/agent/extensions/phi-browser`, which is what lets an Agent Transcript
command wake a live Pi session; run `/reload` in an open Pi session afterwards.

Re-running is idempotent (`current`), a link pointing elsewhere is repointed
(`relinked`), and a **real directory** in the way is left untouched
(`blocked`, exit 1) — those are your files, not a link this command made. Pass
`--force` to replace it, `--dry-run` to see the plan first. The link source is
always printed, because it is the same engine this CLI would drive: a sibling
checkout wins over an installed app here exactly as it does everywhere else.

`install browser` installs Phi Browser itself (see [Exit codes](#exit-codes)).

The CLI ships no skill of its own: `phi help` is the command reference, and the
phi-browser skill above is what an agent loads. Agents that used to get a
`skills/phi-cli` sheet can have that directory deleted.

### Credentials — the user's password manager

Signing in comes from the user's vault, not from asking them to paste a
secret. Three commands, ordered by how far the secret travels — use the first
one that does the job:

```bash
phi cred-status                                   # ready / locked / logged_out / not_installed

# 1. Into a page. Phi fills the field itself: app → page, never through the CLI.
phi -s work cred-fill 'loc=css:#login' github.com --field username
phi -s work cred-fill 'loc=css:#password' github.com
phi -s work click @7                              # the Sign in button from the map

# 2. Into a command's environment. app → this process → the child, never printed.
phi cred-run db.internal --env PGPASSWORD=password -- psql -h db.internal -c 'select 1'

# 3. Into your context. Last resort — and the only one that needs --purpose.
phi cred-get github.com --purpose 'write the API token into ~/.netrc' --fields password
```

- **Every** secret-touching call pops an approve/deny prompt in Phi naming the
  caller, the site, and the *kind* of exposure (fill / run / reveal). A
  remembered grant covers only the kind it was approved for, so a denied
  `cred-get` can follow an approved `cred-fill` — that is the user declining
  the escalation, not the task.
- `cred-get` requires `--purpose`. The other two compose their prompt line
  from what they are about to do; a reveal has nothing to compose it from, and
  the most exposing call should not be the one the user approves with the
  least to read.
- **Fills are origin-bound.** Filling a `github.com` login into a page on
  another host is refused (`origin_mismatch`) — that mismatch is exactly how a
  misleading page or an injected instruction would exfiltrate a password.
  Don't route around it with `cred-get`; if the user confirmed the page
  legitimately takes that login (an SSO portal), pass `--allow-cross-origin`.
- **TOTP/2FA is never exposed.** Releasing a live second factor to an agent
  collapses both factors behind one approval — hand the step back:
  `phi handoff "Enter your 2FA code, then hand back"`.
- Secrets don't ride back in: page scans report password inputs as `•••`, and
  every secret the round handled is scrubbed from everything it prints.
  Verify a login by its outcome (the post-submit page), never by reading the
  value back.
- The query is a bare domain, or `--id` / `--search` for vault items that have
  no domain — domain queries reach logins only, so secure notes, cards,
  identities and SSH keys come via `--search 'item name'`. When several items
  match, Phi releases nothing and the call fails `ambiguous` with the
  candidates: narrow with `--username` (or `--id`) and retry. Phi never picks
  an account on the user's behalf.
- Same Agent-permissions gate as browser management (exit **4** when off). A
  vault that will not serve — denied, locked, signed out, not installed —
  exits **6**; see [Exit codes](#exit-codes).

Full semantics live in the engine's `references/credentials.md`.

### Config file

Optional `~/.phibrowser/config.json`, overridden by `./.phibrowser/config.json`.
Keys: `session`, `profile`, `persistent`, `quiet`, `json`, `max`, `lib`,
`canary`. Flags and env vars always win over config. `--shadow` has no config
key on purpose: running invisibly is a per-task decision.

### Relationship to playwright-cli

Near-complete parity with `@playwright/cli`'s command surface. Deliberate
differences, all following from Phi being the live daemon rather than a
throwaway browser:

- **Snapshots print to stdout** (refs `@N`) instead of writing YAML files by
  default; `--filename` writes when you want a file. Refs are CDP
  backendNodeIds, stable across invocations.
- **`show` dashboard** → the native Space switcher pip + Agent Transcript in
  Phi. Nothing to launch.
- **Not ported** (would fight the model, or need deeper lib work): browser
  launch/attach/detach and device emulation (always the user's Phi), profile
  `delete-data` (the profile is the user's real one), `route`/network mocking,
  `tracing-*`, `video-*`. Ask if you need any of these — `route` and tracing
  are feasible via CDP Fetch/Tracing domains.
- **Beyond playwright-cli**: the co-working surface (`handoff`/`takeover`/
  `watch`, `narrate`/`messages`), shadow windows, `article` (Reader View),
  `challenge` detection, `archive` (MHTML), `screenshot --window`, logged-in
  session reuse.

## Dialogs

`dialog accept|dismiss` resolves a native JS dialog (alert/confirm/prompt/
beforeunload) via the browser-level path, so it can reach a dialog opened in
an earlier invocation. **Caveat:** opening a *modal* dialog (`confirm`/`alert`/
`prompt`) inside the hidden agent-Space window can wedge that Space in the
current Phi build — the next command's `enterContext` fails with
`create_failed` until the tab is closed. If you drive a page that pops modal
dialogs, either suppress them (`eval 'window.confirm=()=>true'` before the
action) or handle the whole open-and-dismiss within one round via `run-code`.
A `beforeunload` prompt is the common reachable case and `dialog dismiss`
handles it.

## Testing

`npm test` (or `node test/cli.test.mjs`) runs an end-to-end suite against the
running browser: it exercises every command against a self-contained fixture,
asserts by reading DOM state back through `eval`, smoke-checks capture/flaky
commands, and cleans up every Space, shadow window and management artifact it
creates. Interactive commands (`handoff`/`takeover`/`watch`), profile creation
(undeletable), and modal `dialog` handling (see above) are skipped with a
reason. Requires the "operate your Spaces" toggle for the management-group and
shadow-window assertions; without it, those groups are skipped.

## Co-working rules (inherited from the skill)

- While the **user holds control**, mutating commands fail with "user is
  controlling" (exit code 3). That is a hard stop: `phi watch` blocks
  until hand-back; never retry or `takeover` without the user's say-so.
- Logins, captchas, 2FA, and consequential choices are the user's:
  `phi handoff "Sign in, then hand back"` (add `--wait` to block).
- Cloudflare challenges are never solved by the agent. `phi challenge` detects
  one and `phi challenge --wait` gives a managed check its one bounded chance to
  clear: at most two short passive rechecks per encounter, shared with the check
  page input runs by itself, with no click, reload or navigation. If it remains,
  hand off and do not retry. A hard block (`kind: "blocked"`) has nothing to
  solve, so report it.
- `messages` surfaces commands the user typed into Phi's Agent Transcript
  console; honor them before continuing (`open` warns when any are pending).

## Exit codes

`0` ok · `1` command failed · `2` usage · `3` user holds control ·
`4` browser management / shadow windows disabled · `5` no usable Phi Browser ·
`6` credential request refused

Exit **6** means the vault did not serve and repeating the call cannot change
that — only the user can. Either they denied the approval prompt (their answer
to that exposure; ask them or take a path that needs no secret) or the password
manager is locked / signed out / not installed (`cred-status` says which).
Credential errors the *caller* can fix — `ambiguous`, `origin_mismatch` — stay
at exit 1, because narrowing the query or confirming the page is your move,
not theirs.

Exit **5** means there is no browser to drive, so retrying is pointless until
a human acts. The CLI walks one ladder to say *which* thing to do, in the
order you'd have to do them — each rung's advice is wrong for the rungs above
it, and telling someone on an old build to find a Settings toggle it doesn't
have is the case this avoids.

Rungs 3 and 4 are narrower than they look, because a healthy current setup
never reaches them: the CLI starts Phi when nothing is running, and a current
Phi publishes its socket whether or not agent control is on. So rung 3 means
starting it actually failed, and rung 4 means the running build predates the
always-on socket.

| | Situation | What it does |
|---|---|---|
| 1 | No Phi Browser installed | **offers to install it for you** (see below) |
| 2 | Stable Phi older than **2.4.0** | **offers to update it** — agent control starts at 2.4.0 |
| 3 | Installed and current, would not start | says why — the CLI already tried |
| 4 | Running, but published no socket | an older build: offers to open Settings ▸ General to enable agent control |

**Canary is exempt from rung 2**: it is the prerelease channel and versions
itself by name, so it is never called out of date. Rung 2 also fires when an
older engine loads and lacks the entry points the CLI drives — probed rather
than inferred, so a build that reports no version number is given the benefit
of the doubt. The diagnosis judges a *running* browser when there is one, so
a stale copy in `/Applications` never indicts a current build running from
elsewhere.

The offers never block an agent: no prompt unless stdin *and* stderr are
TTYs, and never with `--json`, `--quiet`, `$CI`, or `$PHIBROWSER_NO_PROMPT`.
Unanswered after 20s it declines and exits.

### Installing Phi Browser from the CLI

Answering **Y** at rung 1 or 2 installs the browser rather than just opening a
web page:

```
phibrowser: Phi Browser is not installed. The CLI drives the app — it needs
Phi Browser 2.4.0+ (free, macOS): https://phibrowser.com/download/latest_dmg

Install Phi Browser 2.4.0 now? [Y/n] y
Downloading Phi Browser 2.4.0 (329 MB)…
  10% … 100%
Verifying signature…
Installed /Applications/Phi.app

Next: just run this again — the CLI starts Phi Browser itself and
Phi asks you to approve this agent, which turns agent control on.
```

Same thing without a terminal, for scripts and provisioning:

```bash
phi install browser              # download, verify, install
phi install browser --dry-run    # report the release, download nothing
phi install browser --canary     # the canary channel, as Phi Canary.app
```

It comes from Phi's own update feed — the Sparkle appcast the app itself
updates from (`https://ota.phibrowser.com/mac-public/…`; `--canary` uses the
`mac-nightly` appcast and installs `Phi Canary.app` beside stable, both
signed with the same key) — so it is the same build and the same channel,
never a scraped link. Trust is **pinned in the
CLI**, since a machine with no Phi on it has nothing to read it from: the
update host, Sparkle's `SUPublicEDKey`, and Developer ID team `87DQ3HMK5G`.
Nothing is unpacked before its EdDSA signature verifies against that key, and
nothing is moved into place before `codesign` confirms that team and
Gatekeeper accepts the bundle. `/Applications` is used when it is writable,
`~/Applications` otherwise (the resolver searches both).

Two refusals are deliberate. A published release **below the 2.4.0 floor** is
not installed — you would get a browser this CLI still declines to drive — so
it says so and points at the download page instead. And a **running** Phi is
never replaced in place; quit it, or use Phi ▸ Check for Updates… inside the
app, which is what Sparkle is for.
