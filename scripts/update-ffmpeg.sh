#!/usr/bin/env bash
# Обновляет ffmpeg.wasm в extension/decoder/vendor/ из npm.
set -euo pipefail
VER="${1:-0.12.10}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/extension/decoder/vendor"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" && npm pack --silent "@ffmpeg/core@$VER" >/dev/null && tar xzf ffmpeg-core-*.tgz)
cp "$TMP/package/dist/esm/ffmpeg-core.js" "$TMP/package/dist/esm/ffmpeg-core.wasm" "$DIR/"
echo "ffmpeg.wasm $VER → $DIR"
