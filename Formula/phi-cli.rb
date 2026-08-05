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
  url "https://registry.npmjs.org/@phibrowser/cli/-/cli-0.3.0.tgz"
  sha256 "28f3cc03bf3d2615c05522814098cb4891da7ccd41dc5cb1ff53157263456503"
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
      The `phi` command drives a running Phi Browser — it is a client, not
      a browser. It loads the automation engine that ships inside the app
      bundle, so:

        1. Install Phi Browser:  brew install --cask phibrowser/tap/phi
        2. Enable Settings > Developer > Remote debugging >
           "Allow agents to control Phi (CDP)"

      The first connection asks for consent in the app. For a non-standard
      install location, point PHIBROWSER_APP at the bundle.
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
