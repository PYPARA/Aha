# Sprite animation workbench

Open **Sprite animation** in the app rail. Import still PNG, JPEG or WebP images,
choose a sheet layout, or use the workbench's conversation to create a character.
Select an image provider/model from the same Drawing configuration. The chat
provider is independent. Choose a canonical character reference before asking
for an action. Each generated action is a separate Drawing job; inspect the
candidate's preview and diagnostics, then adopt it. Existing actions are preserved.

The generation workflow adapts the canonical-reference, coherent action strip,
layout-guide and deterministic processing approach described by Hatch Pet. It
does not install pets or require that skill or Python at runtime. No Hatch Pet
script implementation is copied. Generation is performed by Aha's configured
Drawing channel, and processing uses the bundled sharp dependency.

Projects and adopted images are saved to this browser profile's IndexedDB.
The server retains conversations, generation context, candidates and drawing
history. Export a `.aha-sprite.zip` to transfer the project: it includes original
images and editable frame/action data, but does not transfer credentials, live
conversation bindings or server asset handles. Imported references can be
uploaded again using **Use as reference**. Keep a package backup before clearing
browser data. The app shows storage failures instead of claiming a successful save.

## Export format (version 1)

Both exports are ZIP archives with `animation.json`. Each action has its own
numbered filename/directory, so duplicate or filesystem-unsafe action names do
not collide. Coordinates are pixels, origin top-left; positive Y is down.

```json
{
  "version": 1,
  "width": 256,
  "height": 256,
  "pivot": { "x": 128, "y": 256 },
  "actions": [
    {
      "name": "idle",
      "fps": 12,
      "loop": true,
      "image": "01-idle.png",
      "frames": [{ "x": 0, "y": 0, "width": 256, "height": 256, "durationMs": 83.33333333333333 }]
    }
  ]
}
```

For a PNG sequence, omit the action's `image`; each frame instead has `file`
(e.g. `01-idle/0001.png`) and `durationMs`. Frame order is the array order. Frame
placement is baked into the pixels. Frames are neither rotated nor trimmed.
Atlas spacing is transparent and excluded from each frame rectangle. This is
Aha's portable JSON format, not an engine-specific importer format.

Generation diagnostics check structural problems; they cannot guarantee identity,
correct action semantics or a smooth loop. Review the motion before adoption.
Pure-color background removal can affect similar character colors: choose a
contrasting key, inspect the result, or select native transparency if supported.
Failed/interrupted paid requests are not automatically retried. Page closure does
not cancel a submitted request. Use the candidate's Cancel or Retry controls.
