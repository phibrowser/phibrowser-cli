# Copyright 2026 Phinomenon Inc.
#
# Canonical source for the phi-cli Homebrew formula. `npm run formula`
# rewrites url/sha256 from the published registry tarball; ship it by copying
# this file into the phibrowser/homebrew-tap repo (see RELEASING.md), which is
# what `brew install phibrowser/tap/phi-cli` reads. That tap's `phi` cask is
# the browser; this formula is the CLI that drives it.
class PhiCli < Formula
  desc "Command-line automation for the Phi Browser app"
  homepage "https://github.com/phibrowser/phibrowser-cli"
  url "https://registry.npmjs.org/@phibrowser/cli/-/cli-0.4.0.tgz"
  sha256 "904711d5b0042d53d0d51437536b5b443e23b04d444de7297cd3246203bc69a6"
  license "Apache-2.0"

  # The CLI drives the Phi Browser macOS app over its app-owned Unix socket.
  # Apple silicon only, matching the browser builds it drives.
  depends_on arch: :arm64
  depends_on :macos
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      The `phi` command drives Phi Browser — it is a client, not a browser.
      It loads the automation engine that ships inside the app bundle, so
      install the app first:

        brew install --cask phibrowser/tap/phi

      The first connection asks for your approval in the app, which also
      turns agent control on. For a non-standard install location, point
      PHIBROWSER_APP at the bundle.
    EOS
  end

  # Kept hermetic: every other command needs a running Phi Browser, whose
  # presence differs machine to machine. `phibrowser` is installed too, as a
  # compatibility alias for the same entry point.
  test do
    assert_equal version.to_s, shell_output("#{bin}/phi --version").strip
    assert_match "drive Phi Browser from the command line",
                 shell_output("#{bin}/phi --help")
  end
end
