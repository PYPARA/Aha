# 3D 生成维护约束

使用方式见 [3D 生成](../guides/GEN3D.md)，方案与里程碑见 [3D 生成方案](../design/3d-generation/PRODUCT_SPEC.md)。3D 生成和 3D 工坊相互独立，两者只通过 GLB 和资源中心衔接。复用工坊模块时只引用、不修改（`model3dScene` 的校验、加载和导出函数，`model3dFiles` 路径工具，以及 Blender 运行环境 `BlenderRuntime`）；3D 生成使用自己的查看器。为了共用 Blender 锁，`Model3DHost.blender` 改为只读公开，这是工坊唯一的改动。

## 数据与接口

- **代码位置**：
  - 契约：`packages/contracts/src/gen3d.ts`
  - 服务：`apps/server/src/gen3d/engine.ts`
  - 工具：`apps/server/src/agentGateway/gen3dTools.ts`
  - 桌面宿主：`apps/desktop/src/gen3d/host.ts`（固定脚本 `blenderScripts.ts`，GLB 贴图替换 `glbTexture.ts`）
  - 沙箱运行页：`apps/web/gen3d-runtime.html`、`src/gen3dRuntime.ts`、`src/gen3dWorker.ts`
- **工程目录**：`Documents/Aha/Gen3D/<projectId>/`，文件是数据真相，没有数据库迁移。每个工程串行写入，用修订号防止并发覆盖；requestId 加内容指纹实现幂等提交。版本目录不可覆盖。
- **RPC 与事件**：`gen3d.list/get/command/forThread` 和事件流复用现有 Effect RPC，变更命令要求 owner 会话。资产路由是 `/api/gen3d/assets/<projectId>/versions|blueprint|references|textures/...`。蓝图重新提取时会原地覆盖，所以不缓存；版本、参考图和平铺贴图是不可变的。
- **绘图三视图**：由网页端创建普通绘图任务（会出现在绘图记录里）。完成后用 `import-reference-asset` 提交资产 ID，由 `wsRpc` 通过绘图服务读取字节，再交给引擎规范化为 PNG。不按文件路径读取。
- **平铺贴图**：网页端创建绘图任务，完成后用 `import-texture-asset` 提交资产 ID，由 `wsRpc` 读字节、交给 `addTextureBytes`：裁成不超过 1024 的正方形，用 `makeSeamless`（`@synara/shared/gen3dTexture`，按轴分别与半偏移副本交叉淡化，边界取自图内部）处理成无缝，按内容哈希存到 `textures/<id>.png`，记在 `Gen3DProject.textures`（可选字段，最多 64 张，旧工程没有）。`optimize` 的材质项 `preset: "tiled"` 必须带 `tile`（贴图 id、每次重复的米数、粗糙度），其余预设不能带；宿主把 id 换成工程内文件路径再交给脚本。
- **局部重绘**：只能由工作台发起，`submit` 拒绝带 `repaint` 的构建。
  - `render-view`：`wsRpc` 调 `engine.renderView`，宿主用固定脚本渲染 `views/<versionId>/<view>.png`（1024 正交，渲染结果可重复），再存成绘图资产交给遮罩编辑器。
  - 自由视角（`repaintView: "custom"`）：遮罩在查看器里画在模型表面，存成覆盖模型包围盒的体素网格（`@synara/shared/gen3dPaintMask`：最长边 128 格的立方格子，0–255，按 0.5 阈值三线性采样；行程编码后随 `paintMask` 提交，`repaintCamera` 是查看器相机的方向和上方向，glTF 坐标）。`engine.renderCustomView` 把网格写到 `views/<versionId>/custom-paint.json`（宿主请求体限 16 KB，网格从这个固定位置读），宿主渲染 `custom.png` 和 `custom-mask.png`，并把相机连同取景写进 `custom.json`；`wsRpc` 把两张图都存成绘图资产。`repaintBytes` 对自由视角从 `custom.json` 读相机和取景放进 `build.repaint.camera`，没有取景就拒绝。查看器的显示和脚本用同一个阈值，看到的蓝色区域就是渲染出的遮罩。
  - 网页端用这张图和 `MaskCanvasEditor` 的遮罩（透明 = 重绘区域）创建绘图编辑任务；完成后 `repaint` 只提交任务 ID。`wsRpc` 从绘图服务读出任务的输入图、遮罩和输出，`repaintBytes` 先确认输入图与该版本该视角的渲染逐字节一致（否则投影会错位），再把输出和遮罩缩放到 1024（只接受接近正方形的图）写入任务目录，创建 `mode: "process"`、带 `repaint` 的任务。
  - 只接受带烘焙颜色贴图（`process.baked` 含 `baseColor`）的版本，可以在重绘版本上继续重绘。Agent 工具的 `get.current` 沿父版本链跳过所有优化和重绘版本，回到最近的建模版本。
- **附加关节**：版本不可修改，后补的关节存在 `Gen3DProject.skeletons`（按 versionId，最多 64 组；`origin` 为 ai / template / user，`confirmed`）。工作台用 `set-skeleton`（空数组删除），Agent 工具的 `skeleton` 操作走 `propose-skeleton`，引擎强制记为 `origin: "ai"`、未确认，不消耗轮次。两者都要通过 `validateSkeleton`，且每个关节都在版本包围盒外扩 25% 以内。`rigSkeleton`（`@synara/shared/gen3dVersions`）沿版本链从近到远查找：某个版本的附加关节（默认只认已确认的）优先于它构建时带的骨架。导出时附加关节写成 `skeleton.json`。
  - 关节编辑器把关节画在运行页的 512 像素正交渲染上：取景是最长边的 1.2 倍、以底部居中模型的包围盒中心为中心；正面 x 向右，侧面（相机在 +X）−z 向右（`skeletonJoints.ts`）。改动运行页的渲染取景时必须同步这里。
  - 编辑器只在已保存关节的内容变化时重置本地编辑，项目刷新不会打断拖动。
- **绑定（`rig` 命令）**：只能由工作台发起，`submit` 拒绝带 `rig` 的构建。引擎用 `rigSkeleton` 确认版本链上有已确认的关节，再创建 `mode: "process"`、带 `rig.clips` 的任务。绑定版本的 `model.glb` 是父版本静态网格的原样副本，所以评分、查看器和工坊的模型校验都不受影响（工坊的加载器拒绝蒙皮和动画，不要放宽）；蒙皮动画模型是派生文件 `rigged.glb`（同样要通过 glTF Validator），每段动画另有预览 `anim-<clip>.webp`。版本记录 `process.rig`（类型、骨骼数、片段、按部件绑定的数量）。重绘一个绑定版本时，宿主同样替换 `rigged.glb` 里的基础色图片，并复制预览。
- **风格化（`stylize` 命令）**：只能由工作台发起，`submit` 拒绝带 `stylize` 的构建。精细度范围按风格（`GEN3D_STYLES`）在引擎里检查。宿主发布 Blender 写出的 GLB，版本记录 `process.stylize`（风格、精细度、颜色数、体素和凸点数），`process.baked` 为空，所以不能直接重绘（调色板 UV 被同色的面共用）。
- **道具动画（`animate` 命令）**：只能由工作台发起，`submit` 拒绝带 `animate` 的构建。部件用版本报告里的对象 id（即 `ahaId`），必须都存在、至少留一个网格部件不动；门只能用左右边，盖子必须指定边。和绑定一样，`model.glb` 是父版本的原样副本，动画模型是派生文件 `animated.glb`，预览为 `anim-open|close|spin.webp`，版本记录 `process.props`。导出、重绘与 `rigged.glb` 同等处理。
- **保留部件（`process.keepParts`）**：合并前给每个面写整数属性 `aha_part`（部件名取 `ahaId`，没有时取对象名），烘焙、LOD 和碰撞体之后再按属性拆回部件；部件写回 `ahaId` 并用 extras 导出，运行页报告的 id 与建模版本一致。LOD 仍是合并的一个网格。`texture` 脚本读到多个网格时先合并再渲染和投影，重绘照常可用。
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
- **推理等级**：`ensureGen3DThread` 新建对话时用 `strongestEffortSelection`（`gen3dModelEffort.ts`）把输入框的模型选择提到该模型支持的最高推理等级：优先用运行时发现的 `supportedReasoningEfforts`（4 秒取不到就用静态能力），按 minimal → low → medium → high → xhigh → max 取最高；Codex 写 `options.reasoningEffort`，Claude 写 `options.effort`，其他提供方不变。不显式传等级时，Aha 给 Codex 的轮次默认是 medium（`codexAppServerManager.ts`），会覆盖 `~/.codex/config.toml` 的设置。验收脚本直接建对话时也要在 `modelSelection.options` 里写明等级。
- **对话注入**：`ProviderCommandReactor` 每轮注入规则和当前授权的剩余轮数。一个会话只能绑定一个创作工作台：批量、精灵、3D 工坊、3D 生成互斥检查。删除会话时解除绑定，并停止授权。

## 执行边界

- **桌面宿主**：独立的私有 socket 和随机令牌（`AHA_GEN3D_HOST_PIPE/TOKEN`）。请求只传工程和任务 ID，模型文件通过工程目录交换。
- **编译窗口**：每个任务使用独立 session 分区，拒绝所有权限、禁止新窗口和导航；启动之后只允许 `data:` 和 `blob:` 请求。
- **Worker**：
  - 源码只在 Worker 里执行，注入 `THREE` 和 `SDF`，禁止网络、文件和 DOM。
  - 超时 60 秒，源码最多 1 MiB，模型最多 100 万三角面。
  - `toJSON` 前必须调用 `updateMatrixWorld(true)`，否则用代码设置的位置会丢失。
- **SDF 区域**：`part(name, shape)` 给形状加名字，并集和交集收集子形状的名字，差集保留被减形状的名字，嵌套的名字记录深度。网格化后按每个三角形的中心找最近的命名形状（距离相差不到半个格子时深度大的优先，超过两个格子算未命名）；未命名三角形少于 1% 时并入最近的区域（光滑并集的过渡带）。Worker 的 `SDF.mesh` 有区域时返回一个组，每个区域一个网格（`<id>-<区域>`，剩余部分 `<id>-rest`），可以用 `materials` / `colors` 给区域单独的材质。法线来自 SDF 梯度，区域接缝处没有明暗缝。
  - 区域网格在接缝处是开放的，所以都带 `userData.ahaWeld = <id>`：运行页统计拓扑时把同一 `ahaWeld` 的网格一起按位置焊接，其余网格仍各自统计；保留部件的优化把 `ahaWeld` 写回拆出的部件（glTF extras）。
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
  - `process`：导入父版本 GLB → 清除父子关系并应用变换 → 合并为一个高模 → 可选修复 → Decimate 到目标面数 → 重新底部居中 → 可选 Smart UV + Cycles「选中到活动」烘焙（颜色和金属度都把 Principled 的输入接到发射节点后用 EMIT 烘焙；ROUGHNESS；切线空间 NORMAL；AO）→ LOD → 碰撞体 → 导出。颜色不能用 DIFFUSE 的 COLOR 通道：它乘了 (1 − 金属度)，金属会变黑（M3a 的预设样本里金色部件全黑，M3b 修复）。AO 通过名为 `glTF Material Output` 的节点组的 Occlusion 输入导出，glTF 导出器会把 AO 和粗糙度合并成一张贴图。低模材质开启背面剔除（导出为单面）。优化版本的 GLB 原样发布，不经过运行页重新导出（运行页只负责统计、剪影和渲染），否则会丢掉合并贴图和切线。
  - 减面前清除导入时的自定义拆分法线，减面后删除退化面：否则插值出的零长度法线会被 glTF Validator 拒绝（骑士样本实测）。
  - **参考图投影**（`texture: "projection"`）：复用版本评分时的对齐，而不是重新对齐。链路是 世界坐标 → 蓝图像素（同一 px/m、地面线、各视图按模型 u 范围居中）→ 评分记录的 `shiftPx` 和 `mirrored` → 参考图像素（按 `extractBlueprint` 的统一比例和框中心）。宿主把参考图、三张蓝图剪影、框、px/m 和父版本各视图的配准一起传给脚本。
    - 先用 EMIT 烘焙出低模每个贴图像素的世界坐标和法线（归一化到 0–1，因为发射值不能为负），再对正、背和左右两侧四个方向投影；侧视参考同时用于两侧，另一侧镜像取反。
    - 只接受法线与视线夹角足够小、落在蓝图剪影内、且从该方向对高模做光线检测没有被挡住的像素，按夹角的平方加权混合，权重低处向烘焙颜色过渡；再向岛外扩 8 像素，盖住烘焙边距。超过 1024 的贴图按 1024 计算后放大。
    - 引擎在创建任务时拒绝：没开烘焙、没有确认蓝图或父版本没有评分、蓝图在父版本之后重新提取过。
  - **材质预设**（`materials`）：按 `ahaId`（glTF extras，即报告里的材质 id）找到高模材质，用 Aha 自己的节点图替换 Base Color、Roughness、Metallic、Normal 的输入（噪声、Wave、Voronoi、Bump，喷漆金属用 Pointiness 做边缘磨损），随后的烘焙会把它们变成贴图。AI 不能写材质节点，工坊导出脚本的节点白名单也因此不受影响。
  - **平铺贴图材质**：贴图节点用物体坐标乘 1/重复米数、`BOX` 投影（混合 0.25）铺满；明暗同时驱动凹凸（距离为重复尺寸的 1%）和粗糙度（所选值 ±0.12），烘焙后得到颜色、法线和粗糙度。
  - `texture`（`view` / `repaint` 两种模式）：
    - 视图：七个正交方向（Blender 小键盘命名，glTF +Z 为正面），按模型投影范围的 1.1 倍取景。Cycles 1 采样、极小像素滤波渲染位置和法线（不做抗锯齿，像素中心可精确换算），16 采样渲染发射的基础色；输出的视图图片是基础色乘一个固定的明暗系数（来自法线和固定光向），让绘图模型看得出形体。渲染设置固定，同一版本同一视角的输出逐字节相同，引擎靠这一点核对编辑来源。
    - 自由视角：方向和上方向来自查看器（上方向与方向近乎平行时改用 -Z）。带遮罩网格时，取景对准网格里已涂的格子（跨度 × 1.8 加 6 格，不小于整体取景的 40%，尽量不超出整体画面），每个命中像素按渲染出的位置采样网格得到 2D 遮罩；一个像素都没有时报错「cannot be seen from this angle」，宿主换成给用户的提示。重绘模式直接用 `camera.frame` 复现同一取景。
    - 重绘：EMIT 烘焙每个贴图像素的世界坐标和法线（超过 2048 的贴图按 2048 计算后放大），换算到视图像素；只接受落在画面内、朝向相机、并且就是该像素渲染到的那个表面（与位置图比较，代替光线检测）的像素。权重 = 向内柔化后的遮罩 × 掠射角衰减；编辑图先除以同一明暗系数还原成基础色再混合。权重为 0 的像素保持原值，只向 UV 岛外扩 4 像素。脚本报告改动的纹素数，和 8 位量化后的实际差异一致。
    - 宿主用 `replaceBaseColor`（`glbTexture.ts`）只替换 GLB 里基础色图片的数据，其余 bufferView 按原字节复制；父版本的 LOD 也换上同一张图，碰撞体原样复制。
  - `rig`：
    - 导入父版本 GLB 合并为一个网格，先按距离焊接（glTF 在 UV 接缝处拆开了顶点，热权重需要连通的表面；UV 存在面角上，导出时会重新拆开），再清除自定义法线。
    - 每个关节一根骨骼：头在关节，尾指向后代最多的子关节（同等时优先 spine/chest/neck/head），叶关节沿父方向延长一个半径。骨骼局部 Z 在竖直骨骼上朝前、在水平骨骼上朝上，所以绕局部 X 的旋转总是身体侧平面内的摆动（腿前后摆、尾巴和脖子上下）。
    - 权重：`ARMATURE_AUTO` 热权重；顶点数不少于 20% 的连通部件保留热权重，没解出的顶点用最近两根骨骼按距离混合；更小的部件（头盔、盾牌、耳朵）只用离其中心最近的骨骼和它的父骨骼，否则抬手会带动背后的盾牌（骑士样本实测）。蒙皮网格解除父子关系放在场景根上，只靠 Armature 修改器（glTF Validator 对非根蒙皮网格报警告）。
    - 类型：有 `thigh_l/r` 和 `upperarm_l/r`、前肢末端低于高度 30%、并且 hips 到 chest（或 neck、head、spine）主要是前后方向的为四足；有 `thigh_l/r` 为两足，否则通用。只看前肢高度会把手臂下垂的 Q 版角色误判为四足（AI 关节的骑士实测）。片段用正弦和关键帧插值生成（行走、奔跑为对角步态或交替摆腿，原地动作），每段一条 NLA 轨道，用 `NLA_TRACKS` 导出；关键帧从第 0 帧开始并包含收尾帧（导出器写的是场景时间，否则长度会多一帧）。
    - 预览：Workbench、烘焙贴图、固定 3/4 正交相机，每段 12 帧 256 像素；宿主用 sharp 的 `join.animated` 合成动画 WebP，再删除 PNG。
  - `stylize`：
    - 体素和积木：先标记离表面不超过半个格子对角线的格子（外壳），再从边界向内洪水填充空格子；没被填到的都算实心，所以部件穿插、带小缝的模型也是实心的。只在实心格与外部空格之间出面，同一切片中同色相邻的面用贪心法合并成矩形。积木的格子高是宽的 1.2 倍，每个露出的顶面加一个 10 边形凸点，颜色归到固定调色板。
    - 低多边形：焊接 → Decimate 到目标面数 → 三角化，每个面用中心和三个偏向顶点的采样点取平均色（只取一点时细的深色条纹会染黑整个面），按 5 位量化。
    - 颜色：在源模型上找最近点，按面角 UV 插值采样基础色贴图（或材质颜色）。输出时不用顶点色：Godot 的 glTF 导入不会把 COLOR_0 当作反照率（实测模型发白），改为生成调色板贴图（每种颜色 8 像素一格，最多 4096 色，`Closest` 采样），每个面的 UV 指向自己颜色格的中心。
  - `prop`：按 `ahaId`（或去掉 `.001` 后缀的对象名）找到部件，只移动最上层的选中对象；在它们的整体包围盒上放一个 `Pivot` 空物体，把部件挂到它下面（保持世界变换），只给支点打关键帧。旋转方向在 glTF 坐标里推导：后边合页绕 +X 取负角、前边取正角，左边（+x 端）绕 Z 取负角、右边取正角；门在左边绕 Y 取正角、右边取负角，使远端向上或向前。导出时开启 extras，保留部件的 `ahaId`。
  - `convert` 的动画模式（`rigged: true`，用于绑定版本和道具动画版本的 GLB 和 FBX）：有骨架时保留骨架和蒙皮网格、删除导入器生成的骨骼显示形状；道具动画保留全部部件和支点；不带 LOD；FBX 用 `bake_anim_use_all_actions` 导出所有动作（Unity 里名为 `Pivot|open`）。
  - `convert`：FBX 对所有引擎都写同一套坐标系（`-Z` 前、`Y` 上、`FBX_SCALE_UNITS`），Unreal 导入器会自己换算；把数据改成 Z 轴向上会和文件头矛盾，Godot 导入时会躺倒（已实测）。FBX 里的 LOD 改用 LOD0 的材质，避免每级都带一份贴图。STL 先按距离焊接再统计开放边，因为 glTF 在 UV 接缝处拆开了顶点。
- **查看器**（`Gen3DViewer.tsx`、`gen3dViewerScene.ts`）：3D 生成自己的查看器，不再使用工坊的 `ModelViewer`。
  - 自己的加载函数接受蒙皮和动画（工坊的加载器和 Worker 限制不变），只允许 `data:`/`blob:` 资源，检查大小和贴图解码；它只加载 Aha 已发布、通过 glTF Validator 的文件。版本有 `rigged.glb` 或 `animated.glb` 时加载它（静止姿态与 `model.glb` 相同）。
  - 整个查看器只有一个 WebGL 上下文：版本对比用同一个渲染器左右分屏（剪裁区域），参考叠加时渲染到居中的正方形视口。按需渲染，只有播放动画或转台时才连续出帧；`orbit.update()` 会通过 change 事件排下一帧，循环里必须先判断是否已排帧，否则每帧回调翻倍（实测会卡死页面）。
  - 通道显示用 `MeshBasicMaterial` 的 `onBeforeCompile` 只取一个通道并抵消输出的 sRGB 转换，从而保留蒙皮；权重显示克隆几何体写入顶点色，切换模式时恢复原几何体和材质。
  - 部件选择：点击（拖动超过 4 像素算旋转）用射线找到网格，向上找第一个带 `ahaId` 的对象；叠加和对比时不选。选中的 id 由工作台持有，和道具动画面板共用，切换版本时清空；高亮是主题色的包围盒。
  - 参考叠加的正交取景由 `overlayFrame` 计算，与评分的配准一致（同一 px/m、地面线、按模型 u 范围居中、`shiftPx`，镜像时翻转剪影），单元测试逐点比对评分公式。蓝图剪影作为场景里的平面绘制（轮廓加淡填充，颜色取主题的 `--primary`），不用 HTML 叠加，以适配明暗主题。
- **可信层**（`gen3dRuntime.ts`）：
  - 检查 Worker 输出：沿用工坊的 `validateSceneJSON`，不接受灯光、相机、纹理、动画和骨骼。
  - 归一化到底部居中，导出 GLB 和报告。
  - 按位置焊接后统计开放边和非流形边。
  - 光栅化对齐剪影，渲染缩略图、3/4 视图和三个正交视图。
- **宿主校验**：宿主只接受 PNG 签名正确的图片、通过 schema 的报告和整数拓扑。服务端发布前还要通过 glTF Validator 零错误检查，并计算全部文件的哈希。

## 核心回归

```sh
bunx vitest run packages/shared/src/gen3dSdf.test.ts packages/shared/src/gen3dScore.test.ts packages/shared/src/gen3dTexture.test.ts packages/shared/src/gen3dVersions.test.ts apps/desktop/src/gen3d apps/server/src/gen3d apps/server/src/agentGateway/gen3dTools.test.ts apps/web/src/aha/translations.test.ts apps/web/src/components/resources apps/web/src/components/sprite/spriteNavigation.test.ts apps/desktop/src/model3d
bun run typecheck
bun run build:desktop
```

- 沙箱运行页只能用生产构建验证：开发模式下 Vite 不内联 Worker，CSP 会拦截。
- 固定脚本的源码在 `.tmp/gen3d/m4/`（`process.py`、`convert.py`、`texture.py`、`rig.py`），用其中的 `embed.py` 生成 `blenderScripts.ts`。改动绑定或动画后，用 `.tmp/gen3d/m4/godot/check.gd` 在 Godot 里逐段播放并测量骨骼转角（GLB 和 FBX 都要测）。改动后用 `.tmp/gen3d/m2/` 和 `m3b/` 的脚本跑一遍真实 Blender 和 Godot 导入（Godot 4.7 能直接读 FBX，可以用来核对 FBX 的轴向和单位）。
- 局部重绘的不变量要用真实宿主核对：除基础色外的 bufferView 逐字节相同、改动纹素数等于报告、遮罩外（外扩 3 像素）渲染差异不超过 1 级、另一侧视图逐字节不变（`.tmp/gen3d/m3b/e2e.ts`）。
- 改动 Blender 路线后，还要跑 3D 工坊的核心回归（见 [3D 工坊维护](MODEL3D_WORKSHOP.md)）。
- 真实宿主、隔离后端、真实 Blender 和真实 AI 会话的验收脚本与证据放在 `.tmp/gen3d/`。模拟宿主的测试只证明状态机，不能代替实际的 Worker 和模型会话。
