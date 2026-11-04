# 3D 生成维护约束

使用方式见 [3D 生成](../guides/GEN3D.md)，方案与里程碑见 [3D 生成方案](../design/3d-generation/PRODUCT_SPEC.md)。3D 生成和 3D 工坊相互独立，两者只通过 GLB 和资源中心衔接。复用工坊模块时只引用、不修改（查看器 `ModelViewer`、`model3dScene` 的校验、加载和导出函数，`model3dFiles` 路径工具，以及 Blender 运行环境 `BlenderRuntime`）。为了共用 Blender 锁，`Model3DHost.blender` 改为只读公开，这是工坊唯一的改动。

## 数据与接口

- **代码位置**：
  - 契约：`packages/contracts/src/gen3d.ts`
  - 服务：`apps/server/src/gen3d/engine.ts`
  - 工具：`apps/server/src/agentGateway/gen3dTools.ts`
  - 桌面宿主：`apps/desktop/src/gen3d/host.ts`
  - 沙箱运行页：`apps/web/gen3d-runtime.html`、`src/gen3dRuntime.ts`、`src/gen3dWorker.ts`
- **工程目录**：`Documents/Aha/Gen3D/<projectId>/`，文件是数据真相，没有数据库迁移。每个工程串行写入，用修订号防止并发覆盖；requestId 加内容指纹实现幂等提交。版本目录不可覆盖。
- **RPC 与事件**：`gen3d.list/get/command/forThread` 和事件流复用现有 Effect RPC，变更命令要求 owner 会话。资产路由是 `/api/gen3d/assets/<projectId>/versions|blueprint|references/...`。蓝图重新提取时会原地覆盖，所以不缓存；版本和参考图是不可变的。
- **绘图三视图**：由网页端创建普通绘图任务（会出现在绘图记录里）。完成后用 `import-reference-asset` 提交资产 ID，由 `wsRpc` 通过绘图服务读取字节，再交给引擎规范化为 PNG。不按文件路径读取。
- **蓝图提取、评分和差异图都在服务端完成**（sharp 加 `@synara/shared/gen3dScore`），没有桌面宿主时也能提取蓝图。
  - 对齐：纵向用共同的物理比例（px/m）和地面线，横向搜索 IoU 最大的平移；侧视另外尝试镜像。不能按各自的包围盒缩放或居中。
- **构建契约**：`Gen3DBuild.mode`（`threejs`、`blender`、`process`）、`skeleton` 和 `process` 都是可选字段，没有 `mode` 的旧版本按 `threejs` 处理，所以不需要迁移。`Gen3DVersion.runtime.blender` 记录 Blender 版本。
- **提交前检查**：骨架用 `validateSkeleton`（`@synara/shared/gen3dSdf`）检查 id 唯一、父节点存在、无环、半径为正、最多 256 个节点；Blender 构建先查询宿主的 Blender 是否就绪。这两项都在消耗授权轮数之前完成。骨架写入任务目录的 `skeleton.json`（`format`、`units`、`upAxis`、`nodes`）。
- **优化（`optimize` 命令）**：只能由工作台发起，`submit` 拒绝 `mode: "process"`。引擎检查宿主有可用的 Blender（`environment.blender.headless`，只需要 Blender 本体），然后创建一个 `mode: "process"`、`source` 为空、父版本为所选版本的任务。发布时 `lod1–3.glb` 和 `collision.glb` 和 `model.glb` 一样要通过 glTF Validator，版本记录 `process`（`Gen3DProcessReport`）。优化任务不属于迭代授权，不消耗轮数。Agent 工具的 `get.current` 遇到优化版本时返回它的父版本，另给 `optimizedPreview`。
- **迭代授权（run）**：只能由工作台创建。
  - 有授权时，每次提交消耗一轮；用完后拒绝提交。
  - 没有授权时，同一个 turnId 只能提交一次；工作台的「重试构建」不带 turnId。
  - 停止规则：最大偏差区域低于 `stopMaxRegionPct`（2%），或连续两轮提高不足 `stopMinGain`（1 分），或轮数用完。
  - 重启后，active 的授权会标为 interrupted，不会自动续跑。
- **Agent 工具** `gen3d`：只开放 get、views（以图片返回蓝图、差异图和渲染图）、submit、status、report，并校验活跃会话和轮次。采用、导出、归档只能在工作台操作。
- **对话注入**：`ProviderCommandReactor` 每轮注入规则和当前授权的剩余轮数。一个会话只能绑定一个创作工作台：批量、精灵、3D 工坊、3D 生成互斥检查。删除会话时解除绑定，并停止授权。

## 执行边界

- **桌面宿主**：独立的私有 socket 和随机令牌（`AHA_GEN3D_HOST_PIPE/TOKEN`）。请求只传工程和任务 ID，模型文件通过工程目录交换。
- **编译窗口**：每个任务使用独立 session 分区，拒绝所有权限、禁止新窗口和导航；启动之后只允许 `data:` 和 `blob:` 请求。
- **Worker**：
  - 源码只在 Worker 里执行，注入 `THREE` 和 `SDF`，禁止网络、文件和 DOM。
  - 超时 60 秒，源码最多 1 MiB，模型最多 100 万三角面。
  - `toJSON` 前必须调用 `updateMatrixWorld(true)`，否则用代码设置的位置会丢失。
- **SDF**（`@synara/shared/gen3dSdf`）：窄带 Surface Nets，按 4³ 分块；每块用 `prune` 剔除包围盒不相交的基元，分辨率 16–256。`roundCone` 是两端为球、侧面相切的精确距离；`skeleton(nodes)` 为每段骨头生成一个 `roundCone` 再平滑并集，Worker 通过 `params.skeleton` 拿到骨架。
- **Blender 路线**（`apps/desktop/src/gen3d/host.ts`、`blenderPrelude.ts`）：
  - `main.ts` 把工坊宿主的 `BlenderRuntime` 交给 3D 生成宿主，两个工作台共用一个实例，也就共用一个忙碌锁。工坊宿主没启动时，Blender 路线不可用。
  - 原样调用 `BlenderRuntime.build`：源码是 Aha 前置代码加 AI 源码，骨架作为 JSON 字符串放进 `parameters.skeleton`；`parentBlend` 和 `parentGlb` 都是 null，每轮都从空场景按完整源码重建。工坊的 AST 发布规则会检查合并后的源码，所以前置代码也不能出现文件、路径、动态属性等被禁止的名字。
  - 锁被占用时，按 `Another Blender modeling task is running` 这条错误每 2 秒重试，最多等 `blenderWaitMs`（90 秒）。宿主期限是等待时间加 `blenderBuildMs` 再加 60 秒，服务端请求超时按路线分别设置，Blender 更长。
  - Blender 导出的 GLB 交给沙箱运行页（任务带 `input`，用 `loadModel` 加载，不执行源码），归一化、统计、剪影、渲染和 Three.js 路线一致。中间文件 `blender-output.glb` 发布前删除，`model.blend` 作为版本文件保留。固定导出脚本的警告并入报告，但「缺少 UV」除外：运行页已按 glTF 节点名逐个报告，Blender 用的是物体名（如 `Ear_0049` 和 `Ear 0.049`），两边无法去重。
  - 报错里的行号会换算回 AI 自己的源码：策略检查减去前置代码行数，Python 运行错误再减去工坊注入的 2 行参数代码（`mapBlenderError`）。
  - 取消和超时会调用 `BlenderRuntime.cancel`，只终止 Aha 保存的进程句柄。
  - 前置代码提供 `aha_point`（Y 向上转成 Blender 的 Z 向上）、`aha_skin`、`aha_material`。`aha_skin` 用 Skin 加细分修改器；细分会把截面收缩到约 0.93 倍（Blender 5.2 实测，1–3 级相同），所以半径乘 1.075 补偿。Skin 身体在叶关节处结束，`SDF.skeleton` 则会在每个关节加一个该半径的球。
- **固定后处理脚本**（`blenderScripts.ts`，原型和调试在 `.tmp/gen3d/m2/`）：
  - 宿主用 `blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python <脚本> -- <config.json>` 运行，只传 schema 校验过的参数，不经过 MCP，也不执行 AI 代码。必须带 `--python-exit-code 1`，否则 Python 报错时 Blender 仍返回 0。stdout 和 stderr 都写进任务目录的 `blender-<kind>.log`，结果从 `AHA_PROCESS=` / `AHA_CONVERT=` 行读取。
  - 这些后台进程不占用工坊的 MCP 锁（是独立进程，不连接 GUI 实例），但 3D 生成内部排队，一次只跑一个；超时 `processMs`（10 分钟），取消和退出时只终止 Aha 保存的进程句柄。
  - `process`：导入父版本 GLB → 清除父子关系并应用变换 → 合并为一个高模 → 可选修复 → Decimate 到目标面数 → 重新底部居中 → 可选 Smart UV + Cycles「选中到活动」烘焙（DIFFUSE 颜色、ROUGHNESS、用 EMIT 代替的金属度、切线空间 NORMAL、AO）→ LOD → 碰撞体 → 导出。AO 通过名为 `glTF Material Output` 的节点组的 Occlusion 输入导出，glTF 导出器会把 AO 和粗糙度合并成一张贴图。低模材质开启背面剔除（导出为单面）。优化版本的 GLB 原样发布，不经过运行页重新导出（运行页只负责统计、剪影和渲染），否则会丢掉合并贴图和切线。
  - 减面前清除导入时的自定义拆分法线，减面后删除退化面：否则插值出的零长度法线会被 glTF Validator 拒绝（骑士样本实测）。
  - **参考图投影**（`texture: "projection"`）：复用版本评分时的对齐，而不是重新对齐。链路是 世界坐标 → 蓝图像素（同一 px/m、地面线、各视图按模型 u 范围居中）→ 评分记录的 `shiftPx` 和 `mirrored` → 参考图像素（按 `extractBlueprint` 的统一比例和框中心）。宿主把参考图、三张蓝图剪影、框、px/m 和父版本各视图的配准一起传给脚本。
    - 先用 EMIT 烘焙出低模每个贴图像素的世界坐标和法线（归一化到 0–1，因为发射值不能为负），再对正、背和左右两侧四个方向投影；侧视参考同时用于两侧，另一侧镜像取反。
    - 只接受法线与视线夹角足够小、落在蓝图剪影内、且从该方向对高模做光线检测没有被挡住的像素，按夹角的平方加权混合，权重低处向烘焙颜色过渡；再向岛外扩 8 像素，盖住烘焙边距。超过 1024 的贴图按 1024 计算后放大。
    - 引擎在创建任务时拒绝：没开烘焙、没有确认蓝图或父版本没有评分、蓝图在父版本之后重新提取过。
  - **材质预设**（`materials`）：按 `ahaId`（glTF extras，即报告里的材质 id）找到高模材质，用 Aha 自己的节点图替换 Base Color、Roughness、Metallic、Normal 的输入（噪声、Wave、Voronoi、Bump，喷漆金属用 Pointiness 做边缘磨损），随后的烘焙会把它们变成贴图。AI 不能写材质节点，工坊导出脚本的节点白名单也因此不受影响。
  - `convert`：FBX 对所有引擎都写同一套坐标系（`-Z` 前、`Y` 上、`FBX_SCALE_UNITS`），Unreal 导入器会自己换算；把数据改成 Z 轴向上会和文件头矛盾，Godot 导入时会躺倒（已实测）。FBX 里的 LOD 改用 LOD0 的材质，避免每级都带一份贴图。STL 先按距离焊接再统计开放边，因为 glTF 在 UV 接缝处拆开了顶点。
- **可信层**（`gen3dRuntime.ts`）：
  - 检查 Worker 输出：沿用工坊的 `validateSceneJSON`，不接受灯光、相机、纹理、动画和骨骼。
  - 归一化到底部居中，导出 GLB 和报告。
  - 按位置焊接后统计开放边和非流形边。
  - 光栅化对齐剪影，渲染缩略图、3/4 视图和三个正交视图。
- **宿主校验**：宿主只接受 PNG 签名正确的图片、通过 schema 的报告和整数拓扑。服务端发布前还要通过 glTF Validator 零错误检查，并计算全部文件的哈希。

## 核心回归

```sh
bunx vitest run packages/shared/src/gen3dSdf.test.ts packages/shared/src/gen3dScore.test.ts apps/server/src/gen3d apps/server/src/agentGateway/gen3dTools.test.ts apps/web/src/aha/translations.test.ts apps/web/src/components/resources apps/web/src/components/sprite/spriteNavigation.test.ts apps/desktop/src/model3d
bun run typecheck
bun run build:desktop
```

- 沙箱运行页只能用生产构建验证：开发模式下 Vite 不内联 Worker，CSP 会拦截。
- 改动固定后处理脚本后，用 `.tmp/gen3d/m2/` 的脚本跑一遍真实 Blender 和 Godot 导入（Godot 4.7 能直接读 FBX，可以用来核对 FBX 的轴向和单位）。
- 改动 Blender 路线后，还要跑 3D 工坊的核心回归（见 [3D 工坊维护](MODEL3D_WORKSHOP.md)）。
- 真实宿主、隔离后端、真实 Blender 和真实 AI 会话的验收脚本与证据放在 `.tmp/gen3d/`。模拟宿主的测试只证明状态机，不能代替实际的 Worker 和模型会话。
