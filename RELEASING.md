# Releasing

Two install paths, one artifact: Homebrew installs the same npm tarball that
`npm install -g @phibrowser/cli` does, so the registry publish comes first and
the formula follows it.

## One-time setup

- **npm** — the package is scoped and public. Be a member of the `phibrowser`
  npm org (`npm org ls phibrowser`) and logged in (`npm whoami`). The first
  publish creates the package; `publishConfig.access: public` keeps it from
  defaulting to restricted.
- **Homebrew tap** — Homebrew reads formulae from a repo named
  `homebrew-<tap>`, so `brew install phibrowser/tap/phibrowser` resolves to
  `github.com/phibrowser/homebrew-tap`. Create it once:

  ```bash
  brew tap-new phibrowser/tap                     # scaffolds it locally
  cd "$(brew --repository phibrowser/tap)"
  git remote add origin git@github.com:phibrowser/homebrew-tap.git
  git push -u origin HEAD
  ```

  `Formula/phibrowser.rb` in *this* repo is the canonical copy; the tap gets a
  copy of it each release.

## Cutting a release

```bash
npm version <patch|minor|major>     # bumps package.json, commits, tags
npm run formula -- --local          # restamp the formula from the local pack
npm publish                         # prepublishOnly gate runs first
npm run formula                     # restamp from the registry (authoritative)
```

`npm pack` is byte-reproducible, so the `--local` hash normally equals the
registry one and the last step is a no-op that proves it. If it *does* change
the file, the registry wins — commit that.

`prepublishOnly` runs `scripts/preflight.mjs`, which refuses to publish when
the bin is not executable, `--version` disagrees with `package.json`, the
tarball is missing a runtime file or carrying tests, or the formula is stale.

Then ship the formula:

```bash
git commit -am "chore: release v$(node -p 'require("./package.json").version')"
git push --follow-tags

cp Formula/phibrowser.rb "$(brew --repository phibrowser/tap)/Formula/"
cd "$(brew --repository phibrowser/tap)" && git commit -am "phibrowser <version>" && git push
```

## Verifying

```bash
npm run formula -- --check                     # formula matches the registry
brew style ./Formula/phibrowser.rb
brew install phibrowser/tap/phibrowser && phibrowser --version
brew test phibrowser/tap/phibrowser
```

To exercise `brew install` *before* publishing, copy the formula into the tap
with the `url` pointed at a local `npm pack` tarball (`file:///…/x.tgz`) and
install that under a throwaway name.

> `brew uninstall` autoremoves orphaned dependencies by default. Prefix with
> `HOMEBREW_NO_AUTOREMOVE=1` when cleaning up test installs so it does not
> sweep unrelated formulae.

## Version policy

The CLI loads the phi-browser engine out of the installed app bundle, so its
version tracks the CLI surface only — a Phi Browser update can change engine
behavior without a CLI release, and that is intended. Bump minor for new
commands or flags, patch for fixes, major for a breaking change to command
names, flag meanings, or exit codes.
