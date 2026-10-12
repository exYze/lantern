#!/usr/bin/env bash
# Builds Lantern on a Mac: the universal macOS app (.app + .dmg) and an iOS Simulator build.
#   ./scripts/build-mac.sh              macOS + iOS Simulator
#   ./scripts/build-mac.sh --skip-ios   macOS only
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. $2" >&2; exit 1; }; }
need node "Install Node.js 22+ (brew install node)."
need cargo "Install Rust: curl https://sh.rustup.rs -sSf | sh"
xcode-select -p >/dev/null 2>&1 || { echo "Install Xcode from the App Store, then run: xcode-select --install" >&2; exit 1; }

npm ci

echo "==> macOS (universal: Apple silicon + Intel)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin
echo "    → src-tauri/target/universal-apple-darwin/release/bundle/macos/Lantern.app"
echo "    → src-tauri/target/universal-apple-darwin/release/bundle/dmg/"

if [[ "${1:-}" != "--skip-ios" ]]; then
  echo "==> iOS Simulator"
  command -v xcodegen >/dev/null 2>&1 || brew install xcodegen
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
  [[ -d src-tauri/gen/apple ]] || npx tauri ios init
  npx tauri ios build --target aarch64-sim --debug
  echo "    → src-tauri/gen/apple/build/"
  echo "    Run it in the Simulator with: npx tauri ios dev"
  echo "    For a device/App Store build, set your team in Xcode and run: npx tauri ios build"
fi
