#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
APP="release/mac-share/Tally.app"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) DMG_ARCH="arm64" ;;
  x86_64) DMG_ARCH="x64" ;;
  *) echo "不支持的 macOS 架构：$ARCH" >&2; exit 1 ;;
esac
DMG="release/Tally-v${VERSION}-mac-${DMG_ARCH}.dmg"

if [[ ! -d "$APP" ]]; then
  echo "缺少 $APP，请先运行 npm run build && npm run mac:share" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/tally-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

ditto "$APP" "$STAGE/Tally.app"
ln -s /Applications "$STAGE/Applications"

echo "· 生成 $DMG"
hdiutil create \
  -volname "Tally" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG"

echo "· 校验 $DMG"
hdiutil verify "$DMG"

echo "· SHA-256"
shasum -a 256 "$DMG"
