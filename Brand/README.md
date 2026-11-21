# Kestrel brand

- `masters/bird.svg` is the master: the app icon on a 1024 grid (macOS rounded-square tile,
  824 px at 100,100, radius 185) with the bird the UI draws beside the "kestrel" wordmark
  (Lucide `bird`, ISC licence), in the app's dark greys and ink colour.
- `exports/` is generated from it by `scripts/release/make-icon.sh`: `icon.icns` (the app and
  DMG volume icon), `icon-512.png` (the Dock icon of a checkout) and the PNG sizes. Change the
  master, run the script, commit both.
