# 创作功能维护

本文收敛精灵与资源中心多轮实施后仍需遵守的数据和交互约束。使用方式分别见[精灵工作台](../guides/SPRITE_WORKFLOW.md)和[资源中心](../guides/RESOURCE_CENTER.md)，UI 按[公共规则](../UI_GUIDELINES.md)实现。历史方案的版本名称不等于存储版本，也不应覆盖当前源码行为。

3D 工坊的执行隔离、不可变版本、Blender MCP 与 GLB 导出约束单独见 [3D 工坊维护](MODEL3D_WORKSHOP.md)。3D 入库复用本文的持久化复制回执，以工程和版本标识来源；模型文件不进入图像资产清理链。

## 精灵数据与处理

- 工程主版本保持v1/v2；新字段按兼容方式读取，旧图片、3×3布局、任务冻结参数和已采用动作不自动重切或改写。工程包保留素材、规格、基准历史、来源和处理快照，移除会话绑定。
- 角色参考图、动作输出单帧、整张生图请求和导出倍率分别建模。`spriteSizing.ts` 统一布局计算；默认256单帧、8帧、1×来源对应4×2格、1024×512。生成任务每段最多8帧，总动作最多32帧；手工修帧使用独立的1024格/实例及64MP处理容量。
- 稳定格子身份、动作归属与全局帧序用于提示词、布局图、任务、分析、处理和编辑，不把物理行等同于动作。`SpriteEditDescription.version=1` 保存格子、有序帧实例、共同变换、逐帧偏移、可选锚点及时间。
- 实时画布为草稿预览；验证处理使用实际管线。修正只在逻辑母版与输出帧各烘焙一次，采用不重复叠加。像素模式按逻辑像素编辑并以最近邻处理；插画保留平滑缩放与半透明边缘。共同对齐不消除跳跃等有意位移。
- 确认先持久化授权任务和 `prepared` 阶段，再调用绘图服务。状态不确定时先通过幂等键核实，不能盲目重发。免费处理、恢复、导入和保存修帧不触发生图；收费重试需要明确确认。
- `spriteRecovery.ts` 分别验证容器、任务、方案与基准。只有来源可核实的历史本地导入编号才迁移；先备份原JSON，再原子保存。异常记录保留诊断，可用正式动作继续可读。无法完整枚举素材引用时暂停素材清理，避免丢失付费原图、基准历史和动作版本。
- 草稿、处理版本和已采用动作独立；并发冲突保留草稿和可撤销入口。预览与导出只使用正式动作，不混入未采用候选。

## 资源库与索引

- 目录映射物理路径，位置与展开按稳定ID记忆。外部重命名跟随新路径，失效位置回到可用祖先。浏览偏好v2兼容旧项目聚合与目录递归偏好；搜索和选择不跨重启恢复。
- 查询、计数、递归范围和定位页码使用同一过滤/排序逻辑，目录优先，资源ID为最终稳定排序键。混合目录内容共同分页，每页100项；旧查询仍默认仅名称搜索，`total` 仍为匹配项总数。
- 契约可选的 `searchIn`、`revision`、扫描状态、目录及页统计兼容旧调用，`locate` 沿用既有IPC分组。旧接口无统计时显示未知，不补造完整数值。
- 扫描在临时集合中执行，元数据和SQLite提交成功后才发布新版本。不可读目录不当删除；失败保留旧索引并暂停写入，成功重扫后解除。快照与页面版本冲突时重读。
- 目标未选用 `null`，明确选择库根用空路径；两者不能互换。保留路径防逃逸、不跟随符号链接、独占目标、父子去重及批量预检规则。
- 导航、树焦点、内容选择、详情草稿和预览对象分别管理。复用公共Tree、WorkAreaPanel、Dialog、Sheet和预览底板，不在业务内建立另一套外壳。

## 批量生图与共同调度

- 批次契约在 `packages/contracts/src/imageBatches.ts`，SQLite Repository 与服务在 `apps/server/src/imageBatches/`。迁移 **138_ImageBatches** 追加建立批次、结果、引用与索引，不重排 135/136/137 或上游兼容链。迁移支持已知历史谱系的幂等重放。
- 草稿、待应用方案、执行快照、尝试与结果分开保存。修改、应用方案与执行确认都校验草稿版本；方案不能隐式更新草稿。一个批次同一时间只能有一次活跃执行。归档和执行状态独立。
- 执行确认先持久化完整快照及待派发尝试，再创建现有生图任务。确认请求 ID 和内容指纹形成回执；回执先于版本校验，已接受的确认在后续草稿修改后仍可找回。同一 ID 不得对应不同内容。
- 尝试 ID 与输出序号共同形成结果 ID，图片内容哈希只表示资产字节，不表示候选身份。仅可靠保存的原图进入结果；补齐重试沿尝试谱系扣除已保存候选。
- 生图业务来源由服务端调用路径设置。普通绘图创建参数不接受批次或精灵身份。绘图默认来源过滤在数据库查询中执行，搜索、分页与计数使用相同条件；未知旧数据保持可达。精灵旧记录只由可核实的工程任务引用补来源。
- 批量与直接绘图共用引擎并发池。批量每渠道上限为 `max(1,concurrency-1)`（渠道并发最多 50），为直接绘图保留一个；直接绘图优先，批次按渠道轮转。暂停/阻塞策略在派发前读取持久化执行。限流、认证和额度错误只阻塞对应渠道后续批量请求，用户继续后解除，不能因旧错误反复重新阻塞。
- 重启前未发送的确认任务可恢复。`running` 或网络结果不明进入待核实，不能自动补发。`saving` 用原始响应清单恢复，不重新调用模型。取消时已经返回、正在保存的批量响应继续可靠落盘。
- 批次引用和结果加入现有图像 GC 的引用检查。批次资料存储在状态目录 `image-batches/<id>/sources`，参考图与结果仍使用现有 `drawing` 资产。删除会话只解除绑定，不删除批次快照、资产或付费结果。精灵引用读取异常时停止原图清理。
- 任务数不设上限；启用任务的计划图片仍受 500 张约束，执行确认按尝试合计图片数校验。`image_batch` 工具用显式 `catch` 把引擎的真实拒绝原因返回给模型，不能退回 `Effect.tryPromise` 的通用错误。
- 方案可带 `defaults`（`stylePrompt`、`styleReferences`、`parameters`），字段存在即替换，渠道与模型不可由方案修改。`imageBatchProposedDefaults` 是提案校验、应用和预览共用的合并规则；计划图片按合并后的默认参数计算，待处理方案的风格图计入资产引用。
- 任务引用与方案风格图除批次资料、现有任务引用和风格图外，还接受本批 `image_batch_results` 中的资产（`repository.resultAssets`），其他批次的结果一律拒绝。结果作参考只更新草稿，不建立任务依赖。
- 执行确认与预检可带 `providerId`、`model`：只替换同时跟随批次渠道与模型的任务，单独设置渠道或模型的任务先固定为当前配置；冻结进尝试，不写回草稿。可带 `taskIds` 只生成这些任务（按当前草稿设置，不论是否启用），用于行内、抽屉和结果卡片的「重新生成」；尝试级的补齐/重新生成仍走 `retry`。批次摘要的 `tasks` 是全部任务数，`enabled` 是会被确认的任务数。
- 任务行状态取各任务在所有执行中的最近一次尝试（`BatchTaskStatus.tsx`）；行内重新生成/补齐复用执行面板的确认流程。结果「作为参考图」默认只作用于所选任务，加入批次风格参考图需在对话框中明确选择。
- 任务 `output` 是相对交付路径（契约 `ImageBatchOutputPath`），冻结进尝试与结果；交付文件名由 `imageBatches/resultNames.ts` 统一生成，无 `output` 的旧结果保持原命名。
- `image_batch` 工具复用 Agent Gateway 和活跃会话/轮次校验。读取、资料报告、提案、状态与结果预览可用；应用、确认、重试只由工作台 RPC 提供。工具读取资料不按扩展名决定是否接收；每项读取失败明确报告，未发送或其他轮次的附件不能混入上下文。
- 跨会话导入必须从规范消息和受管附件记录核实归属、路径、大小及哈希后复制；批次引用使用新身份。嵌入式接收复用普通聊天图片/文件逻辑；批次未发送文件草稿额外保存在独立 IndexedDB 中，不把大文件写入 localStorage。
- 批量入库扩展 `ResourceOrigin.kind=image-batch` 及批次、任务、尝试、结果 ID，不重解释旧 `drawing.batchId`。应用根控制器认证读取原始资产，主进程验证校验和并执行独占复制、元数据与索引提交。持久化操作在桌面资源配置旁的 `.collections.json`，与可重建搜索索引独立。
- 收集项可带 `folder`（目标目录下的相对子目录），准备时逐段按 `safeName` 校验，提交时 `ensureFolder` 逐级创建并以目录条目写入索引，不跟随符号链接；`folder` 参与同 ID 请求内容比对，旧回执无此字段照常恢复。
- 复制前记录目标库、目录稳定身份、目标路径、预留资源 ID 和文件身份。文件提交后回执丢失，按结果来源或准确的文件身份恢复。相同结果在同库去重，部分失败仅重试失败项；移动、重命名保留资源 ID，废纸篓不触发自动入库。入库补保存绝不调用图像模型。
- 入库开始前在批次服务登记活跃操作，回执与来源关联完成后再释放；原图清理检查这项保留。尚未完成或无法核实的入库操作、无法完整枚举的精灵引用都会阻止清理，不能仅因批次已移除而回收资产。

## 模块间传递与确认

- 模块之间传图只用 `resources/resourceLibrary.ts` 的传递队列：发送方 `queueResourceTransfer`（`resources/transferTargets.tsx` 的 `sendFilesToTarget` 负责新建批次与导航），接收方 `useResourceAttachments` 按序号返回接收与拒绝结果。target 约定：`drawing`、会话 ID、`sprite:<projectId>`、`sprite:new`（精灵库在用户建好项目后 `retargetResourceTransfer`）和 `image-batch:<batchId>`。资源中心来源带 `libraryId` 并在资源中心显示状态和重试；其他来源的失败由全局 `ResourceTransferNotice` 提示。
- 精灵接收的图片只进入项目素材，批量接收的图片只进入批次风格参考图，都不触发生成。精灵导出入库走 `collectResources`，`ResourceOrigin.kind=sprite` 带 `projectId`。
- 批次风格（`defaults.stylePrompt`/`styleReferences`）只在 `confirm` 路径读取并冻结：尝试保存未加风格的 `prompt` 与 `stylePrompt`，`references` 已含风格图；发送与结果使用 `imageBatchComposePrompt`。重试只复用尝试冻结的风格，不读取当前 defaults。风格图计入资产引用，防止被清理。
- 业务确认使用 `ui/confirm-dialog.tsx` 的 `confirmDialog`（单例宿主挂在 `routes/_chat.tsx`），标题写明对象，说明写明影响与能否恢复，破坏性操作用 destructive 并默认聚焦取消。不在业务中使用 `window.confirm`。
- 文案键在 `aha/*Copy.ts` 与 `translations.ts` 合并；`aha/translations.test.ts` 禁止同一键在不同文件给出不同译文。

## 回归与证据

改动时按影响运行实际核心测试，命令入口可从以下范围选择：

```sh
bunx vitest run packages/contracts/src/sprite*.test.ts apps/server/src/spriteAnimation apps/server/src/agentGateway/sprite*.test.ts apps/server/src/imageGeneration/imageGeneration.test.ts apps/web/src/components/sprite/*.test.ts apps/desktop/src/sprites/library.test.ts
bunx vitest run apps/desktop/src/resources apps/web/src/components/resources/resourceSelection.test.ts apps/web/src/components/resources/resourceNavigation.test.ts apps/web/src/components/resources/resourcePreferences.test.ts
bun run --cwd apps/web test:browser src/components/sprite src/components/resources
 bunx vitest run apps/server/src/imageBatches apps/server/src/agentGateway/imageBatchTools.test.ts apps/desktop/src/resources/collection.test.ts
 bun run --cwd apps/web test:browser src/components/imageBatches
 AHA_IMAGE_BATCH_E2E=1 bunx vitest run apps/web/src/components/imageBatches/imageBatches.e2e.test.ts
AHA_SPRITE_E2E=1 bunx vitest run apps/web/src/components/sprite/sprite.e2e.test.ts
bun run typecheck
bun run build:desktop
```

`aha:package` 会整体替换 `release/mac-arm64/` 并对未用 Developer ID 签名的构建做 ad-hoc 签名，交付前用 `codesign --verify --deep --strict release/mac-arm64/Aha.app` 复核。

本机E2E必须显式启用，并使用独立数据目录和本机图片mock。默认跳过不算验收通过；图像夹具只证明管线和交互，不能证明真实模型的动作艺术质量。源码构建、浏览器检查与正式应用实机验收分别记录，不用方案图替代实现截图。

测试证据写入 `.tmp/validation/`，每次交付在忽略目录记录实际命令、结果及未覆盖项。原始日志和截图不进入长期文档；仍有效的约束应更新本文或对应使用说明。
