#!/bin/sh
# Regenerates the app icons from the inline SVG below. Requires ImageMagick.
# The glyph is drawn as a path (not text) so rendering needs no font.
set -e
cd "$(dirname "$0")/.."

cat > /tmp/protein-icon.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#111111"/>
  <!-- Scaled to 80% so the glyph survives Android's maskable safe zone. -->
  <g transform="translate(256,256) scale(0.8) translate(-256,-256)" fill="#ffffff" fill-rule="evenodd">
    <path d="M136 110 H286 A90 90 0 0 1 286 290 H196 V402 H136 Z
             M196 170 H286 A30 30 0 0 1 286 230 H196 Z"/>
  </g>
</svg>
SVG

magick -background none /tmp/protein-icon.svg -resize 512x512 icon-512.png
magick -background none /tmp/protein-icon.svg -resize 192x192 icon-192.png
magick -background none /tmp/protein-icon.svg -resize 180x180 apple-touch-icon.png
echo "icons written"
