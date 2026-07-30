# Copyright 2026 Phinomenon Inc.
#
# Canonical source for the phibrowser Homebrew formula. `npm run formula`
# rewrites url/sha256 from the published registry tarball; ship it by copying
# this file into the phibrowser/homebrew-tap repo (see RELEASING.md), which is
# what `brew install phibrowser/tap/phibrowser` reads.
class Phibrowser < Formula
  desc "Command-line browser automation for Phi Browser"
  homepage "https://github.com/phibrowser/phibrowser-cli"
  url "https://registry.npmjs.org/@phibrowser/cli/-/cli-0.1.0.tgz"
  sha256 "0decda6fb38346e0f810235c80aa3f4a7cc80edb6649ad605d78ad2b7d1e836f"
  license "Apache-2.0"

  # The CLI drives the Phi Browser macOS app over its app-owned Unix socket.
  depends_on :macos
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      phibrowser drives a running Phi Browser — it is a client, not a browser.
      It loads the automation engine that ships inside the app bundle, so:

        1. Install Phi Browser:  https://phibrowser.com
        2. Enable Settings > Developer > Remote debugging >
           "Allow agents to control Phi (CDP)"

      The first connection asks for consent in the app. For a non-standard
      install location, point PHIBROWSER_APP at the bundle.
    EOS
  end

  # Kept hermetic: every other command needs a running Phi Browser, whose
  # presence differs machine to machine.
  test do
    assert_equal version.to_s, shell_output("#{bin}/phibrowser --version").strip
    assert_match "drive Phi Browser from the command line",
                 shell_output("#{bin}/phibrowser --help")
  end
end
