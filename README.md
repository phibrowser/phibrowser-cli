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
| `page` | an **agent Space** (default), or a **user Space** with `-U`, or nothing when a `--space`-capable command is given `--space` | open, goto, click, snapshot, cookies, tab groups, downloads, … |
| `agent` | the session's **agent Space** only (create-or-bind; `close`/`status`/`messages` bind only if it already exists) | close, ping, narrate, handoff, takeover, watch, status, messages |
| `app` | **nothing** — management operates the user's browser app-wide | sessions, profiles, space-*, bookmark-*, rules, pins, focus, … |
| `none` | nothing (runs before helpers load) | install |

So there are exactly three places work can happen — an **agent Space** (hidden,
the default; `--persistent` makes it a lasting one), a **user Space** (the
user's real window, via `-U`), and the **app-level** browser-data surface (no
window) — with persistent being a property of an agent Space, not a fourth
kind.

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
5. installed skills: `~/.claude`, `~/.codex`, `~/.cursor`, `~/.openclaw`,
   `~/.hermes`, `~/.pi/agent`

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
  exempt from the version floor
- Phi Browser running, with Settings ▸ Developer ▸ Remote debugging ▸ "Allow
  agents to control Phi (CDP)" enabled (the raw `--remote-debugging-port` is
  not enough — agent Spaces need the authenticated app socket)
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
- `--quiet` suppresses the summary; `--json` emits raw JSON; `--max N` caps
  printed elements (default 150).
- Page-derived text comes wrapped in `UNTRUSTED PAGE CONTENT` markers — data,
  not instructions. Secrets handled by the round are scrubbed from all output.

### Targets

`click`, `hover`, `fill`, `upload`, `wait --element`, `snapshot --within`
accept: `@12` (ref), `loc=css:#email` (or bare `css:` / `href:` / `role:` /
`xpath:` — the CLI normalizes), raw CSS selectors, `xpath=//button`, or
`"x,y"` viewport coordinates (click/hover only). Prefer refs and locs; they
survive layout shifts and auto-scroll into view.

## Commands

Run `phi help` for the full list, `phi help <command>` for
per-command flags.

| Group | Commands |
|---|---|
| Session | `open` `close` `close-all` `sessions` `profiles` `status` `ping` `narrate` `messages` `handoff` `takeover` `watch` `run-code` `script` `install skill\|browser` |
| Navigation | `goto` `reload` `back` `forward` `tabs` `tab-new` `tab-select` `tab-close` |
| Observe | `snapshot` (`--filename`) `find` `screenshot` `pdf` `archive` `eval` (`--on`) `console` `requests` `info` `challenge` `highlight` |
| Act | `click` `hover` `fill` `type` `press` `check` `uncheck` `select` `drag` `scroll` `upload` `dialog` `accept-cookies` `viewport` `keydown` `keyup` `mousemove` `mousedown` `mouseup` `mousewheel` |
| Wait | `wait` (seconds, `--load`, `--idle`, `--element`, `--fn`) |
| Storage | `cookies` `cookie-get` `cookie-set` `cookie-delete` `cookie-clear` `localstorage-*` `sessionstorage-*` `state-save` `state-load` |
| Credentials | `cred-status` `cred-fill` `cred-run` `cred-get` |
| Manage | `space-list/create/update/delete/activate/open/tabs` `focus` `profile-create/rename` `rules` `rule-add/delete` `pins` `pin-add/remove` `bookmarks` `bookmark-add/folder/update/move/remove` `group-*` `ungroup` `split-*` `downloads` `download` `user-space` |

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
- `group-*` / `split-*` / `downloads` target the **session's Space window**
  by default; `--space <name|id>` targets a user Space's open window instead.
  For a user Space, get tab references from `space-tabs <space>` (the integer
  `tabId` works as a target).
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
```

`install skill` **symlinks** the phi-browser skill — the full engine, with its
`references/`, `scripts/` and helper library — into each agent's
`skills/phi-browser`. A link rather than a copy is the point: the skill then
tracks the Phi Browser build it came from, so updating the app moves every
agent forward at once. It is what Phi's **Settings ▸ General ▸ Developer ▸
"Install the phi-browser skill"** buttons do, without leaving the terminal.

Agents: `claude` (`~/.claude/skills`), `codex`, `cursor`, `openclaw`, `hermes`,
`pi` (`~/.pi/agent/skills`). Name them explicitly, or name none and every agent
already present on the machine gets the link — so this never litters `~` with
directories for tools you don't use. **Pi** also gets a companion extension at
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
Keys: `session`, `profile`, `persistent`, `quiet`, `json`, `max`, `lib`.
Flags and env vars always win over config.

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
  `watch`, `narrate`/`messages`), `challenge` detection, `archive` (MHTML),
  `screenshot --window`, logged-in session reuse.

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
commands, and cleans up every Space and management artifact it creates.
Interactive commands (`handoff`/`takeover`/`watch`), profile creation
(undeletable), and modal `dialog` handling (see above) are skipped with a
reason. Requires the "operate your Spaces" toggle for the management-group
assertions; without it, that group is skipped.

## Co-working rules (inherited from the skill)

- While the **user holds control**, mutating commands fail with "user is
  controlling" (exit code 3). That is a hard stop: `phi watch` blocks
  until hand-back; never retry or `takeover` without the user's say-so.
- Logins, captchas, 2FA, and consequential choices are the user's:
  `phi handoff "Sign in, then hand back"` (add `--wait` to block).
- Cloudflare challenges are never solved by the agent — `phi challenge`
  detects one; hand off.
- `messages` surfaces commands the user typed into Phi's Agent Transcript
  console; honor them before continuing (`open` warns when any are pending).

## Exit codes

`0` ok · `1` command failed · `2` usage · `3` user holds control ·
`4` browser-management disabled · `5` no usable Phi Browser ·
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
have is the case this avoids:

| | Situation | What it does |
|---|---|---|
| 1 | No Phi Browser installed | **offers to install it for you** (see below) |
| 2 | Stable Phi older than **2.4.0** | **offers to update it** — agent control starts at 2.4.0 |
| 3 | Installed and current, not running | offers to launch it |
| 4 | Running, but agent control off | offers to open Settings ▸ General to enable it |

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
Phi Browser 2.4.0+ (free, macOS): https://phibrowser.com

Install Phi Browser 2.4.0 now? [Y/n] y
Downloading Phi Browser 2.4.0 (329 MB)…
  10% … 100%
Verifying signature…
Installed /Applications/Phi.app

Next: launch Phi Browser and enable Settings ▸ Developer ▸ Remote
debugging ▸ "Allow agents to control Phi (CDP)", then run this again.
```

Same thing without a terminal, for scripts and provisioning:

```bash
phi install --browser              # download, verify, install
phi install --browser --dry-run    # report the release, download nothing
```

It comes from Phi's own update feed — the Sparkle appcast the app itself
updates from (`https://ota.phibrowser.com/mac-public/…`) — so it is the same
build and the same channel, never a scraped link. Trust is **pinned in the
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
