#!/usr/bin/env bash
#
# Regenerates the raster app icons in apps/web/public from the two SVG masters
# beside them (logo.svg and logo-maskable.svg).
#
# **Run this by hand, on macOS, only when the logo changes.** The PNGs it
# produces are committed, so neither the build nor CI depends on this script or
# on the tool it uses — `qlmanage`, macOS's own QuickLook thumbnailer, which is
# the only SVG rasterizer present on a stock machine here (no rsvg-convert, no
# ImageMagick, no sharp in this workspace). A committed icon set also means a
# Linux CI box and a fresh clone both get the same bytes.
#
# The sizes are the ones that are actually fetched:
#   - 180 apple-touch-icon.png  iOS home screen
#   - 192 / 512 icon-*.png      the web app manifest (Android, installed PWAs)
#   - 512 icon-maskable.png     Android's circular mask, from the maskable master
#   - 32 favicon-32.png         the classic desktop favicon fallback
# Modern browsers take favicon.svg itself and never fetch a PNG at all.

set -euo pipefail

cd "$(dirname "$0")/.."
PUBLIC="apps/web/public"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v qlmanage >/dev/null 2>&1 || {
  echo "ERROR: qlmanage not found — this script only runs on macOS." >&2
  exit 1
}

# qlmanage names its output "<input file name>.png" and only takes a single
# max dimension, so each size is rendered into its own directory and moved.
render() {
  local source="$1" size="$2" target="$3"
  local out="$WORK/$size"
  mkdir -p "$out"
  qlmanage -t -s "$size" -o "$out" "$source" >/dev/null 2>&1
  local produced="$out/$(basename "$source").png"
  [ -f "$produced" ] || {
    echo "ERROR: qlmanage produced nothing for $source at ${size}px" >&2
    exit 1
  }
  mv "$produced" "$PUBLIC/$target"
  echo "  $target (${size}px)"
}

echo "rendering icons from $PUBLIC/logo.svg"
render "$PUBLIC/logo.svg" 180 apple-touch-icon.png
render "$PUBLIC/logo.svg" 192 icon-192.png
render "$PUBLIC/logo.svg" 512 icon-512.png
render "$PUBLIC/logo.svg" 32 favicon-32.png
echo "rendering maskable icon from $PUBLIC/logo-maskable.svg"
render "$PUBLIC/logo-maskable.svg" 512 icon-maskable.png

echo "done."
