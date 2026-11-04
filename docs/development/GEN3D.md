# 3D 生成维护约束

使用方式见 [3D 生成](../guides/GEN3D.md)，方案与里程碑见 [3D 生成方案](../design/3d-generation/PRODUCT_SPEC.md)。3D 生成和 3D 工坊相互独立，两者只通过 GLB 和资源中心衔接。复用工坊模块时只引用、不修改（查看器 `ModelViewer`、`model3dScene` 的校验和导出函数，以及 `model3dFiles` 路径工具）。

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
- **SDF**（`@synara/shared/gen3dSdf`）：窄带 Surface Nets，按 4³ 分块；每块用 `prune` 剔除包围盒不相交的基元，分辨率 16–256。
- **可信层**（`gen3dRuntime.ts`）：
  - 检查 Worker 输出：沿用工坊的 `validateSceneJSON`，不接受灯光、相机、纹理、动画和骨骼。
  - 归一化到底部居中，导出 GLB 和报告。
  - 按位置焊接后统计开放边和非流形边。
  - 光栅化对齐剪影，渲染缩略图、3/4 视图和三个正交视图。
- **宿主校验**：宿主只接受 PNG 签名正确的图片、通过 schema 的报告和整数拓扑。服务端发布前还要通过 glTF Validator 零错误检查，并计算全部文件的哈希。

## 核心回归

```sh
bunx vitest run packages/shared/src/gen3dSdf.test.ts packages/shared/src/gen3dScore.test.ts apps/server/src/gen3d apps/server/src/agentGateway/gen3dTools.test.ts apps/web/src/aha/translations.test.ts apps/web/src/components/resources apps/web/src/components/sprite/spriteNavigation.test.ts
bun run typecheck
bun run build:desktop
```

- 沙箱运行页只能用生产构建验证：开发模式下 Vite 不内联 Worker，CSP 会拦截。
- 真实宿主、隔离后端和真实 AI 会话的验收脚本与证据放在 `.tmp/gen3d/`。模拟宿主的测试只证明状态机，不能代替实际的 Worker 和模型会话。
