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

## Storage locations and lifecycle

The workbench currently splits editable projects and generation data across two
stores. It does not automatically save either into the Resource center.

| Data                                                                       | Location                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Editable project, imported/adopted image Blobs, actions and frame settings | Current browser profile and origin's IndexedDB database `aha-sprites-v1`, object store `projects` |
| Generation context, candidate records and conversation bindings            | `<stateDir>/sprites/<projectId>.json` and `thread-<threadId>.txt`                                 |
| Uploaded references, generated images, processed frames and thumbnails     | `<stateDir>/drawing/assets/<sha256>.original`, `.edit` and `.thumbnail`                           |
| Drawing jobs and asset metadata                                            | `<stateDir>/state.sqlite`                                                                         |
| Generation responses awaiting local saving/recovery                        | `<stateDir>/drawing/pending/<jobId>.json`; removed when saving completes normally                 |
| Exported project packages and animation ZIPs                               | The destination used by the download flow                                                         |

`stateDir` is `userdata` beneath the application's data root for normal operation,
or `dev` when using the development web server. The standard production default
root is `~/.aha-next`; release flavor, `AHA_HOME` and launch configuration can
override it. These are path rules, not a report of the current running instance's
directory. IndexedDB belongs to the browser/Electron profile, not this server
directory; backing up the server directory alone does not back up editable
projects. Clearing site data or changing browser profiles/origins can make those
projects unavailable. If connected to a remote server, server paths are on that
server while IndexedDB remains in the client profile.

**Delete currently removes only the local IndexedDB project.** It does not remove
server generation records, conversation bindings or their assets. The drawing
service cleans up otherwise unused assets older than 24 hours, but persistent
sprite records protect their references, sources and processed frames from that
cleanup. Deleting a local project therefore does not reclaim all associated
server storage. Adopting generated images also stores image Blobs in IndexedDB,
so client and server copies can both occupy space.

Use **Save package** before clearing browser data or moving profiles. An
`.aha-sprite.zip` transfers the editable project, included images and provenance,
but not the full server generation history, live conversation, credentials or
server asset handles. An atlas/PNG-sequence export is an output artifact rather
than a complete editable-project backup. Downloads are not automatically added
to the Resource center.

Sharing the drawing asset store provides useful content deduplication and
generation recovery. The remaining limitations are the browser-only source of
truth for editable projects and the incomplete deletion lifecycle. A future
storage change should persist editable projects in the application data directory,
use IndexedDB as a cache, support explicit collection into the Resource center,
and reclaim assets using live references across projects and drawing jobs. This
is a recommendation; no migration or automatic cleanup change is implemented.

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
