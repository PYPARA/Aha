# Default Aha application icon

`icon-master.png` is the original 1024 × 1024 image supplied for the unskinned
application. Character skin artwork lives separately in `../elation` and
`../furina`.

Regenerate the platform icons and their desktop/web copies from the repository root:

```sh
bun apps/desktop/scripts/prepare-default-icon.ts
```

The script preserves the original image, applies the existing rounded-mask and
padding convention for desktop PNG/ICNS artwork, and generates ICO and favicon
sizes. ICNS contains standard PNG representations, so regeneration does not
require macOS `iconutil`. Preparing a character skin must not overwrite these
application defaults.
