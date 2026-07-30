# Releasing

Two install paths, one artifact: Homebrew installs the same npm tarball that
`npm install -g @phibrowser/cli` does, so the registry publish comes first and
the formula follows it.

## One-time setup

- **npm** — the package is scoped and public. Be a member of the `phibrowser`
  npm org (`npm org ls phibrowser`) and logged in (`npm whoami`). The first
  publish creates the package; `publishConfig.access: public` keeps it from
  defaulting to restricted.
- **Homebrew tap** — `github.com/phibrowser/homebrew-tap` already exists and
  is public. It currently serves `Casks/phi.rb` (the browser); the CLI adds
  `Formula/phi-cli.rb` alongside it, so one tap serves both:

  ```bash
  brew install --cask phibrowser/tap/phi   # the browser
  brew install phibrowser/tap/phi-cli      # the CLI
  ```

  `Formula/phi-cli.rb` in *this* repo is the canonical copy; the tap gets a
  copy of it each release. Every commit in that tap has landed through a PR
  (there is no branch protection enforcing it — it is convention), so send
  one rather than pushing to `main`.

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

# tap: land the formula through a PR, matching how every other commit got there
gh repo clone phibrowser/homebrew-tap /tmp/phi-tap && cd /tmp/phi-tap
git checkout -b phi-cli-<version>
cp ~/Phi/phibrowser-cli/Formula/phi-cli.rb Formula/
git add -A && git commit -m "phi-cli <version>" && git push -u origin HEAD
gh pr create --fill
```

## Verifying

```bash
npm run formula -- --check                     # formula matches the registry
brew style ./Formula/phi-cli.rb
brew install phibrowser/tap/phi-cli && phi --version
brew test phibrowser/tap/phi-cli
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
