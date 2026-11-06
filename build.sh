#!/bin/bash
# 在 macOS 上把 Sources 编译成 unsigned IPA（TrollStore 可直接装）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="PipiMusic"
SRC="$ROOT/$APP_NAME/Sources"
WEB="$ROOT/$APP_NAME/Web"
OUT="$ROOT/build"

echo "==> clean"
rm -rf "$OUT"
mkdir -p "$OUT/Payload/$APP_NAME.app"

SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
echo "==> SDK: $SDK"

echo "==> compile (arm64)"
xcrun -sdk iphoneos swiftc \
  -target arm64-apple-ios14.0 \
  -sdk "$SDK" \
  -O -whole-module-optimization \
  -o "$OUT/Payload/$APP_NAME.app/$APP_NAME" \
  "$SRC"/*.swift \
  -framework UIKit \
  -framework WebKit \
  -framework AVFoundation \
  -framework CommonCrypto

echo "==> bundle resources"
cp "$ROOT/$APP_NAME/Info.plist" "$OUT/Payload/$APP_NAME.app/Info.plist"

# Web 目录整包塞进 .app/Web
mkdir -p "$OUT/Payload/$APP_NAME.app/Web"
cp -R "$WEB"/. "$OUT/Payload/$APP_NAME.app/Web/"

# 图标放 .app 根，系统按 CFBundleIconFiles 找 AppIcon60x60@2x/@3x
cp "$WEB/AppIcon60x60@2x.png"     "$OUT/Payload/$APP_NAME.app/" 2>/dev/null || true
cp "$WEB/AppIcon60x60@3x.png"     "$OUT/Payload/$APP_NAME.app/" 2>/dev/null || true
cp "$WEB/AppIcon76x76@2x~ipad.png" "$OUT/Payload/$APP_NAME.app/" 2>/dev/null || true
cp "$WEB/AppIcon1024.png"         "$OUT/Payload/$APP_NAME.app/" 2>/dev/null || true

echo "==> sign (ad-hoc)"
if command -v ldid >/dev/null 2>&1; then
  ldid -S "$OUT/Payload/$APP_NAME.app/$APP_NAME"
  echo "    ldid ok"
else
  echo "    ldid 缺失，尝试 codesign ad-hoc"
  codesign --force --sign - --timestamp=none \
    "$OUT/Payload/$APP_NAME.app/$APP_NAME" || echo "    codesign 也失败，留 unsigned"
fi

echo "==> package ipa"
cd "$OUT"
zip -qr "$APP_NAME.ipa" Payload
cd "$ROOT"
cp "$OUT/$APP_NAME.ipa" "$ROOT/$APP_NAME.ipa"

echo
echo "==> done"
ls -lh "$ROOT/$APP_NAME.ipa"
echo
echo "结构："
find "$OUT/Payload" -maxdepth 2 -type f | head -20

# build trigger: iOS 1.0.0
