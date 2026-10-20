# 创作功能维护

本文收敛精灵与资源中心多轮实施后仍需遵守的数据和交互约束。使用方式分别见[精灵工作台](../guides/SPRITE_WORKFLOW.md)和[资源中心](../guides/RESOURCE_CENTER.md)，UI 按[公共规则](../UI_GUIDELINES.md)实现。历史方案的版本名称不等于存储版本，也不应覆盖当前源码行为。

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

## 回归与证据

改动时按影响运行实际核心测试，命令入口可从以下范围选择：

```sh
bunx vitest run packages/contracts/src/sprite*.test.ts apps/server/src/spriteAnimation apps/server/src/agentGateway/sprite*.test.ts apps/server/src/imageGeneration/imageGeneration.test.ts apps/web/src/components/sprite/*.test.ts apps/desktop/src/sprites/library.test.ts
bunx vitest run apps/desktop/src/resources apps/web/src/components/resources/resourceSelection.test.ts apps/web/src/components/resources/resourceNavigation.test.ts apps/web/src/components/resources/resourcePreferences.test.ts
bun run --cwd apps/web test:browser src/components/sprite src/components/resources
AHA_SPRITE_E2E=1 bunx vitest run apps/web/src/components/sprite/sprite.e2e.test.ts
bun run typecheck
bun run build:desktop
```

本机E2E必须显式启用，并使用独立数据目录和本机图片mock。默认跳过不算验收通过；图像夹具只证明管线和交互，不能证明真实模型的动作艺术质量。源码构建、浏览器检查与正式应用实机验收分别记录，不用方案图替代实现截图。

测试证据写入 `.tmp/validation/`，每次交付在忽略目录记录实际命令、结果及未覆盖项。原始日志和截图不进入长期文档；仍有效的约束应更新本文或对应使用说明。
