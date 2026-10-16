# Sprite animation workbench

Open **Sprite animation** in the app rail. Import still PNG, JPEG or WebP images,
choose a sheet layout, or use the workbench's conversation to create a character.
For a multi-action sheet, choose its grid (for example 8 columns × 9 rows),
then use **Split rows into actions**. The dialog previews each row, lets you name
and enable its action, and skips fully transparent cells by default. A fully empty
row is disabled. Names are user supplied: a sprite sheet alone does not describe
what its animations mean. **Apply slicing** remains available to append the whole
grid to the selected action. Row import removes the initial whole-sheet placeholder,
keeps existing edited actions and can be undone in one step.

Right-click an action or use its **⋯** button to rename, duplicate or delete it.
Double-click its name to rename. A project retains at least one action: the last
action's menu offers **Clear action frames** instead of deletion. All action edits
can be undone.

**Image sources** contains user-managed source images only. Adopted generated frames are internal action dependencies and do not appear as separate materials. Explicitly use **Import as image source** for a candidate original, or **Save current frame as material** for a frame. Click a source to slice
it, double-click its name to rename, or use its right-click/**⋯** menu. Deleting a
source confirms all affected actions/frame counts, removes its referenced frames,
and keeps action names. Undo restores the artwork and frames. Renaming changes only
the display name, never the image identity or persisted file path.

The source right-click and **⋯** menus also offer **Copy Image**, alongside rename,
add to conversation and delete. Copy uses the full source at its original dimensions,
not the thumbnail or current frame. PNG transparency is preserved; JPEG/WebP sources
are converted to PNG for the clipboard. A success message appears only after copying
completes; clipboard failures are reported in the workbench.

Use the small **Add to conversation** icon beside a source to attach its full image
to the active chat composer. **Add current frame to conversation** crops the current
frame as a transparent PNG. It does not add another image source, overwrite draft
text, or send a message. The target chat is captured at click time; switching chats
during image processing never reroutes the attachment. Normal composer image limits,
processing and persistence apply. Failed intake is reported and can be retried.
Generation results offer **Add to plan references**. This adds the original candidate image to the visible current draft, or creates a revision draft first. There is no hidden default reference. Removing the image from the card also clears its selected state in task details.

The frame picker offers strip/grid views. Click to select one frame, Shift-click
for an anchored continuous range, Command/Ctrl-click to toggle individual frames,
and Command/Ctrl+Shift-click to add a range. Drag on empty space to box-select with
edge scrolling; Command/Ctrl box-select adds to selection. Drag a frame to reorder
it, or drag selected frames together in their original order. **New action from
selection** copies the selection in original order with fresh frame IDs, preserving
FPS/loop and the original action. **Keep selected frames only** removes other frames.
Frame options include select all, clear, invert and move earlier/later. In the frame
picker, Command/Ctrl+A selects all, Escape clears and Delete/Backspace removes selected
frames. These shortcuts never intercept text fields or the conversation composer.

## Confirmed generation plans

Select a Drawing provider/model independently of the chat model. The conversation
prepares an editable **Sprite generation plan** card; no image request is submitted
until you click **Confirm and generate**. The same server-backed card is available
from ordinary chat history and the sprite editor’s conversation. The left sidebar contains generation tasks; the central workspace contains the editor and a compact link to a pending plan. Edit the requirements, actions,
frames, FPS, loop, background, references and Drawing settings in place, or ask the
conversation to update the draft. Edits save automatically; confirmation is disabled
while saving or when required settings are missing. Conflicting edits require reloading
the plan. Confirmed settings are immutable; changes and retries prepare a new draft, never an image request.
Each conversation has at most one current draft. Repeated clicks on the same source
reuse it. With another draft open, choose **Continue editing current plan** or
**Discard current draft and create this plan**; replacement is atomic and checks the
visible version. Older duplicate drafts are retained as replaced history.
Client-created drafts also appear in ordinary chat history without another AI turn.

Plans appear after their assistant explanation and before later user messages.
Use the title arrow to collapse them. Drafts start expanded; confirmed and dismissed
plans start collapsed. Confirmation closes the configuration and leaves progress and
a result link. Collapsing keeps auto-save running, and disclosure preference is saved
locally per plan. A collapsed plan’s summary still shows unsaved changes or errors.

The agent asks up to three questions in one round only for material ambiguity in
character identity/version, style or view that cannot be resolved from the conversation
or references. Settled preferences are not asked again. The card uses one **Prompt**
for subject, style, view, proportions and creative requirements. **Edit plan** copies
previous text and settings without an AI request. To ask AI to revise it, use the
conversation; the agent reads the latest saved draft and updates only requested fields.
Legacy split fields are merged into one prompt, and empty migrated drafts recover their
retained original text. Confirmed snapshots remain unchanged. Clear conflicting background
instructions identify the original fragment and link to prompt editing; technical keywords
alone do not invalidate a plan. Background and model parameters are inside collapsed Drawing
settings; output frame dimensions are shown only for animation.

For multiple actions, **One sheet for all actions** is the default: one image task
creates a sheet with one row per selected action. Columns equal the maximum frame
count. Frames read left to right and shorter rows leave their trailing cells empty.
For example, 8 idle frames, 12 walking frames and 6 jumping frames use a 3 × 12 grid,
26 valid frames and 10 unused cells. **One image per action** creates independent
queued tasks, confirmed together. Quality, image size and format configure the
entire generated image; frame width/height apply after deterministic slicing.

New projects default to transparent backgrounds. Existing projects retain their
saved background. Transparent output requires PNG or WebP; chroma backgrounds allow
a configurable key color. Native alpha is preserved. Unexpected opacity, occupied
unused cells, empty valid frames, boundary clipping and near-duplicate frames produce
warnings rather than automatically submitting another paid request. Valid empty frames
are retained to preserve timing. Structural checks cannot guarantee character identity,
action semantics or a smooth loop: inspect the result before adoption.

The first reference defines the subject appearance for animation. Additional references
can have style/pose purposes and pose references may apply to specific actions. The ordered
list is the actual input image order; the layout guide is appended separately. Upload, paste
or drop images directly into the card, or choose thumbnails from sent conversation attachments,
project sources and generated candidates. Explicitly selected project candidates from other
conversations are imported into this conversation; the agent cannot access them on its own.
Uploads are registered as protected conversation assets without sending a chat message.
Original images and processed frames remain separately selectable. Replace, reorder or remove
references in the same list. The maximum is 15 user images, reserving one layout-guide slot.
Single-image and total input size limits remain enforced. **Full generation inputs** shows
compiled prompt, ordered inputs and actual settings. Model capabilities depend on the Drawing
provider and rejected parameters are surfaced without automatic retries.

With text-only requirements, first confirm a character-reference plan and choose its
result before confirming animation. Generation never automatically submits both stages.
Combined results share one generation status, then expose per-action frames, FPS,
loop and warnings. Preview individual actions, adopt one or all, or create a confirmed
retry draft for the whole sheet or a single action. Existing edited actions are preserved.
**Adjust original** carries the confirmed grid and action settings into row slicing.
Repeated confirmation is idempotent. After restart, known image jobs are reattached;
uncertain submissions are marked interrupted and require an explicit new confirmation.

## Projects and conversations

The **Sprite animation** rail entry opens the project library. Create a named
project or import an `.aha-sprite.zip`, then click a project to enter its editor.
The library shows thumbnails, names, action counts and update times, with search,
rename and delete controls. The editor URL carries `projectId`, so reloading keeps
the current project open. **Back to projects** waits for saving to complete.
Opening the rail entry always returns to the library; it never creates an empty
project automatically.

From the first message, the editor embeds the ordinary chat composer. Choose the
chat channel, instance, model, attachments and permission mode just as in a normal
conversation. Each project can have several independent ordinary conversations, also accessible
from the chat list after their first send. The right header switches conversations
and creates drafts with **＋**. Histories, composer content and model selections are
separate; sources, edited actions and generation candidates are shared by the project.
Candidate cards identify their originating conversation. Switching waits for the
project association to save and never interrupts a running conversation. New chats
inherit ordinary model preference rules, not another chat's text or reference images. The Drawing provider/model in the editor
is independent and controls image generation. Before dispatch, the app persists
the conversation link, adds sprite guidance and synchronizes the project context.
Initialization failures preserve the ordinary composer content for retry, with the
same thread ID. The service retains all project chat bindings. On the first sprite
tool call of a turn it durably freezes that turn's editing context; later calls and
retry records use their own captured settings despite other chats/editor changes.

## Storage locations and lifecycle

Desktop projects use the system Documents directory under `Aha/Sprite`, alongside
`Aha/Resource`, `Aha/Chats` and `Aha/Studio`. Changing the resource center's selected
folder does not move this sprite folder. The library displays its actual path and
provides **Open in Finder**. Each project uses a stable ID directory:

```text
Documents/Aha/Sprite/<projectId>/
  project.json
  images/<sha256>.png   (or .jpg / .webp)
  thumbnail.png
```

`project.json` stores editable actions, frame settings, relative image paths,
provenance, the conversation ID list and active conversation ID. Imported and adopted source images are included
in `images/`. Images are written before the metadata is atomically committed.
Renaming a project does not rename its directory. Backing up this directory is
sufficient to retain editing/export data, but does not back up the full conversation
or generation history. Failed writes are reported; desktop saving never falls back
to browser storage.

| Data                                                                   | Location                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Desktop editable project and imported/adopted images                   | System Documents directory: `Aha/Sprite/<projectId>/`                                  |
| Browser-only editable projects                                         | IndexedDB `aha-sprite-library-v2`, with separate project, summary and thumbnail stores |
| Generation context, candidates and conversation bindings               | `<stateDir>/sprites/<projectId>.json` and `thread-<threadId>.txt`                      |
| Uploaded references, generated images, processed frames and thumbnails | `<stateDir>/drawing/assets/<sha256>.original`, `.edit` and `.thumbnail`                |
| Drawing jobs, asset metadata and ordinary conversation history         | Existing server persistence under `<stateDir>`                                         |
| Exported project packages and animation ZIPs                           | The destination used by the download flow                                              |

`stateDir` is `userdata` beneath the application's data root in normal operation,
or `dev` for the development web server. The standard production default root is
`~/.aha-next`; release flavor, `AHA_HOME` and launch configuration can override it.
If connected to a remote server, generation data and conversation history are on
that server; desktop editable projects remain on the client machine.

Existing files and the current browser v2 library normalize the former single
`threadId` to `threadIds`/`activeThreadId` on read. Legacy project reference selection
is no longer a generation input. Portable project packages exclude all live chat links.

This is a fresh project library. No old `aha-sprites-v1` IndexedDB data is read,
migrated or automatically removed. A browser without the desktop bridge uses the
new browser database and clearly displays that clearing browser data removes its
projects. Use **Save package** to transfer artwork between machines or browser
profiles. Project packages include editing data, images and provenance, but exclude
live conversation bindings, credentials and server asset handles. Imported
images can be attached again using **Add to conversation**.

Deleting a project persists deletion intent before removing it, cancels active
sprite generation, removes its server records and conversation bindings, and removes
its editable project directory. Ordinary conversation history is retained. Shared
images referenced by other sprite projects or Drawing jobs remain available;
unreferenced images use the existing cleanup policy. Interrupted deletion is shown
in the library with **Retry deletion**. Small persistent tombstones prevent late
saves, polling and callbacks from recreating deleted projects.

Exports and editable projects are not automatically added to the Resource center.
An atlas/PNG-sequence export is an output artifact, not a complete editable backup.

## Export format (version 1)

All export formats are ZIP archives with `animation.json`. The default is a
**Combined PNG atlas + JSON**, with **All actions** checked: one `atlas.png` holds
all non-empty actions in sidebar order. Each action starts on a new row, wrapping
after the chosen number of columns (default 8). Unused cells and spacing (default 0)
are transparent. Width uses the actual maximum occupied column count. Empty actions
are skipped with a visible count; no download is available when the chosen scope
has no frames. Uncheck **All actions** to export only the current action.

**Per-action PNG atlases + JSON** and **PNG sequence + JSON** remain available.
These use numbered filenames/directories, so duplicate or filesystem-unsafe action
names do not collide. Coordinates are pixels, origin top-left; positive Y is down.
For a combined atlas, every action's `image` is `atlas.png`, and all frame rectangles
use absolute coordinates in that image. The version 1 JSON structure is unchanged;
top-level `width` and `height` still describe one frame, not the whole atlas.

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
      "image": "atlas.png",
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
Each atlas is limited to 16384 pixels per side and 64 million total pixels, checked
before allocating its canvas. Oversized exports report an error; adjust columns,
reduce the project canvas size or choose another export format. Export progress and
cancellation apply to all formats.

Generation diagnostics check structural problems; they cannot guarantee identity,
correct action semantics or a smooth loop. Review the motion before adoption.
Pure-color background removal can affect similar character colors: choose a
contrasting key, inspect the result, or select native transparency if supported.
Failed/interrupted paid requests are not automatically retried. Page closure does
not cancel a submitted request. Use **Cancel** for running jobs or **Edit plan and retry** for failed results; the new plan still needs confirmation.

## Generation results

**Generation tasks** is below Actions and Image sources in the resizable left sidebar.
All three sections collapse. Tasks are grouped by confirmation, newest first; split jobs keep
independent status within the group. Click a task for its modal details, candidate thumbnails,
configuration, warnings and error details. **View image** opens a zoomable static preview with
checker/light/dark backgrounds. The task details contain one action list and a single preview/player;
**Open in frame editor** explicitly loads it into the workspace.

**Import as image source**, **Add selected actions** and **Correct frame slicing**
are separate operations. Adoption uses task + original-candidate asset + action identity; old
adoption keys still match the first candidate. Undo restores the whole adoption. Frame corrections
and plan revisions never call an image model. **Edit plan and retry** creates/reuses a confirmation
draft. Active jobs can be cancelled; terminal records can be removed, restored individually or
cleared as a batch with **Undo removal**. Removal hides only this project's records and retains
Drawing jobs, referenced assets and adopted work.

All Drawing outputs are retained as separate candidates. The first is processed automatically;
additional candidates are sliced on selection, with independent frames and errors. Historical
extra outputs are recovered from existing Drawing jobs without generating again. Drawing records
request, returned, saved and failed counts: extra fully saved outputs are successful; missing or
failed saves are partial. Historical status is corrected only when recorded counts prove all
outputs saved; missing evidence is explicitly described and the old status retained.

## Sheet dimensions and layout corrections

New animation plans recommend explicit whole-sheet dimensions from columns × output width
and rows × output height, normalized with the shared Drawing size rules. An 8 × 8 layout
with 256 × 256 output frames starts at 2048 × 2048. The card shows requested sheet size,
expected cell size and final output size separately, including enlargement and dense-layout
notices. A user size is retained when actions change; **Recommend image size again** opts back
into recommendations. `auto` remains available. Provider support is validated by the provider;
these recommendations do not guarantee layout fidelity. Confirmed requests are immutable.
Only requested whole-image size and layout go into automatically compiled image instructions;
post-processing canvas size is kept in the plan. Layout guides match image aspect and mark
planned unused cells separately. Existing user prompt text is preserved.

Grid boundaries are shared between frontend and backend: cumulative integer rounding covers
uneven dimensions without overlap or missing pixels. Fixed-size mode keeps only complete cells.
Candidate inspection stores planned frames, grid positions, nonempty positions and suspected
subjects separately. Foreground projections suggest rows and cells; disconnected fragments,
backgrounds or merged poses can make recognition uncertain. Detection cannot establish animation
quality or semantics. It is cached by candidate/run settings and algorithm version and is not
repeated by polling.

**Correct frame slicing** opens a dedicated central workspace and retains task/candidate identity.
Choose **Use planned grid** or **Use content suggestion**, edit the content bounds, row count,
row/frame boundaries, action names, FPS/loop, frame order and explicit included positions.
Drag guides or use original-image pixel coordinates. The shared canvas/anchor applies the same
nearest-neighbor transform to every frame, preserving intentional motion. Frame content is never
automatically trimmed and centered. Non-integer scaling is reported.

Check each affected action's actual frame count, empty positions and boundaries before saving
it for adoption. Layout changes reset that acknowledgment. A result with seven drawn poses per
row can be reviewed as seven frames while the original eight-frame request stays in history.
**Preview slicing** does not change the saved candidate. **Save slicing correction** creates a
new processing version, switches only after successful processing, and does not adopt or generate
images. **Processing history** can restore an earlier configuration as a new version. Stale edits,
invalid/overlapping regions and missing assets are rejected; the previous usable result remains.
Imported source sheets can enter the same workflow from the source slicing toolbar without an
image-generation request.

Task details place serious issues before the preview, with a direct correction entry. One action
list owns selection, preview focus, frame counts, inspection and adoption state. The fixed footer
adds the selected, eligible actions. Warnings are grouped by category and can locate a frame.
Adopted actions retain their frame snapshot. **Replace with current correction** explicitly
replaces a mapped action while keeping its local identity and supports whole-operation undo.
Save failures are shown before marking an action as added.

Project sources carry `material` or `generated-frame` usage and generated provenance. Frames
are deduplicated by server asset identity; desktop image files are content-addressed. Internal
frames remain in offline projects and ZIP packages. Legacy roles are inferred only from known
candidate-frame assets and adoption provenance, never filenames or sizes. The desktop retains
`project.pre-frame-roles.json` and its referenced files; the browser keeps a migration-backup
store. Uncertain legacy images stay visible. Deleting actions removes unreferenced internal
sources from the live project while undo snapshots retain their Blobs.

## Conversation controls and generation routing

The header uses the app's searchable conversation picker, **＋**, and **⋯** menu.
Archive hides a conversation from the active list; **View archived conversations**
lets you open or restore it. The ordinary archive confirmation preference and
Undo toast apply. Archiving stops the ordinary conversation using its normal
lifecycle, but an already submitted sprite image job may finish as a candidate.

Delete permanently deletes the ordinary conversation and its history, unlinks it
from the sprite project and cancels its unfinished sprite jobs. Adopted artwork,
actions, frames and completed project candidates remain available. Completed
candidates show **Deleted conversation** if their source chat is gone. A draft is
removed locally without creating a server conversation. Closing the last chat
leaves an empty state; use **New conversation** or add an image to start a draft.
Archive/delete from the ordinary chat list is reflected in the editor too.

Switching and managing chats wait for project saving. If the conversation action
succeeds but saving its association fails, the editor displays a retry action;
retry saves the association without repeating the destructive operation. Server
conversation-removal intent survives restart and blocks delayed binding updates.

Sprite guidance is injected by the server into actual provider requests for bound
conversations, including their first send and running-turn steering. Editable
notes are preserved and are not used as system instructions. The sprite tool
resolves the calling turn's user message using its canonical `pendingMessageId`,
including when that user message has a null `turnId`. Future queued messages and
other chats' images are excluded. Errors expose a phase, readable cause, retry
flag and recorded submission/job state in the normal tool details.

This workbench follows character/reference selection → editable plan → explicit
confirmation → combined sheet or individual action strips → deterministic processing
→ candidate preview/adoption. It does not implement Hatch Pet's
complete nine-state, sixteen-direction atlas and automated visual QA pipeline.
Image generation uses the selected Aha Drawing channel/model via `sprite_animation`;
reading or invoking an external imagegen skill is not part of this flow.

## 中文操作要点

- 顶部会话选择器支持按名称搜索；**＋** 新建独立草稿，**⋯** 提供归档、恢复和删除。模型、文字及附件在各会话中独立保存。
- 归档后进入 **查看已归档会话** 查找并恢复，也可使用普通会话的归档撤销提示。已提交的精灵绘图任务可以继续完成。
- 删除会永久清除普通会话历史，并取消该会话未完成的精灵生成；已采纳素材、动作、帧和已完成候选保留。最后一个会话关闭后显示空状态，不生成替代会话。
- 空状态可以点击 **新建会话**，也可以通过素材上的 **添加到会话** 创建草稿并添加图片；不会覆盖文字或自动发送。
- 会话操作已完成但项目关联保存失败时，使用提示中的 **重试**；不会重复删除会话。临时加载失败不会被当成会话不存在。
- 对话模型负责理解需求并创建可编辑的 **精灵生成方案**；修改控件或继续通过会话修改都更新服务端草稿。点击 **确认并生成** 前不会提交生图任务。
- 多动作默认合成一张图，每个动作一行，列数取最大帧数，短动作末尾留空；也可以切换为每个动作单独生成。每个动作可单独设置帧数、FPS 和循环。
- 新项目默认透明背景，可切换纯色色键背景；参考图首图确定主体外观，可选风格或姿态用途说明。展开完整生图输入可查看实际提示词及系统布局引导图。
- 出图使用所选绘图渠道和模型。结果可按动作预览、勾选采纳、一次撤销，以及为单个动作创建重做方案；每次重新生成仍需确认。

## 方案与结果的新交互

- 左侧依次管理动作、图片素材和生成任务，支持折叠及调整宽度；中间保留画布、帧编辑和导出，右侧会话准备并确认方案。
- 任务按一次确认分组，点开详情查看全部候选。静态图用「查看图片」打开可缩放大图并切换棋盘／浅色／深色背景；动画在详情内切换动作播放和逐帧检查。
- 「导入为素材」「添加所选动作」「修正切帧」各自独立，采纳支持去重和整次撤销。失败任务可移除、批量清理、撤销及恢复，绘图记录和已采纳作品不受影响。
- 方案统一为目标、一个提示词、参考图、动画动作与帧、绘图配置、确认摘要。背景在绘图配置中；静态图不显示切帧画布设置。
- 「修改方案」直接预填旧内容，不调用 AI。要让 AI 调整时在会话提出要求。旧空白草稿从保留原文恢复；已确认快照不变。
- 同一会话最多一个当前草稿；重复点击复用。另一来源需明确继续或替换。相邻未生成的废弃方案合并为历史列表，不跨用户消息；折叠不打断自动保存。
- 参考图支持上传、粘贴、拖入，以及选择会话附件、本项目素材和候选。首图确定外观，可排序、替换、移除；用途标签只是对同一组模型输入图片的说明。
- 「添加到方案参考图」直接更新可见草稿，取消隐式默认参考。上传无需再发送聊天；其他会话候选只有用户显式导入后才能被当前会话使用。
- 所有候选独立保留原图、处理状态、帧和警告。请求一张返回两张且全部保存成功时为成功；历史第二张从已有任务补齐，不重新生图。历史保存证据不足时保留部分完成状态并说明。
- 只有「确认并生成」触发生图；修改配置、上传参考、移除任务和复制方案不会触发图片请求。

## 布局检查与切帧修正

- 动画方案分别显示请求整图、预计单元格与输出单帧尺寸。8 行 × 8 列、256×256 输出帧的推荐起点为 2048×2048，可手动修改或保留 auto；固定尺寸仍不能保证模型准确画够帧数。
- 原生成方案和切帧修正独立保存。方案 64 帧而原图实际只有 56 个主体时，先按内容建议检查每行边界，再明确确认实际帧数；不会自动复制补帧。
- 「修正切帧」在中央工作区编辑，支持内容区域、行和帧边界、不同帧数、顺序、FPS、循环和共同画布基准。非整除图片按整数边界完整切分，不再因 1199÷8 不是整数直接拒绝。
- 预览不改变已保存结果；保存成功才切换候选处理版本，失败保留之前结果。可恢复旧版本；修改边界会取消之前的检查确认。所有处理不调用绘图模型。
- 任务详情只有一份动作清单、一个预览和一个批量添加主按钮。异常提示置顶，直接进入修正；候选只有一张时不显示重复选择器。
- 添加动作不再把每一帧铺在素材区。内部帧随工程保存，供动作播放与导出；显式导入原图或另存当前帧才新增可见素材。历史来源明确时迁移角色并保留备份，不明来源继续显示。
- 已添加动作不会随候选修正自动变化。通过「用当前修正替换」明确更新，保留动作 ID，可整次撤销；保存失败不会提前标为已添加。
