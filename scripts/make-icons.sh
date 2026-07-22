#!/bin/sh
# Regenerates the app icons from logo.jpg. Requires ImageMagick.
#
# logo.jpg is a mockup: the artwork sits on a rounded white card with a drop
# shadow, on a near-white page. Both iOS and Android mask icons themselves, so
# baking the card in would give doubly-rounded corners with a shadow trapped
# inside them. We crop to the artwork alone and let the platform do the rest.
set -e
cd "$(dirname "$0")/.."

# Bounding box of the artwork inside the card, measured with:
#   magick logo.jpg -crop 510x540+260+230 +repage -fuzz 8% -format "%@\n" info:
ART="301x368+393+328"

# The glyph is taller than it is wide. Scaled so its bounding circle fits
# Android's maskable safe zone (the centre 80%, i.e. radius 0.4 x size), the
# tightest mask any platform applies.
W=0.508
H=0.621

# JPEG leaves the card's white a shade off pure white; snap it back so the icon
# background matches the manifest's #ffffff. Stays clear of the bar's grey.
magick logo.jpg -crop "$ART" +repage -white-threshold 95% /tmp/protein-art.png

for spec in "icon-512.png 512" "icon-192.png 192" "apple-touch-icon.png 180"; do
  set -- $spec
  w=$(awk "BEGIN{printf \"%d\", $2 * $W}")
  h=$(awk "BEGIN{printf \"%d\", $2 * $H}")
  # Force true-colour sRGB with no alpha. The artwork is black/white/grey, so
  # ImageMagick would otherwise write a grayscale PNG — which browsers show fine
  # in the tab but iOS silently refuses to render as a home-screen icon.
  magick /tmp/protein-art.png -filter Lanczos -resize "${w}x${h}!" \
    -background white -gravity center -extent "$2x$2" \
    -alpha off -colorspace sRGB -type TrueColor -strip "$1"
done

echo "icons written"
