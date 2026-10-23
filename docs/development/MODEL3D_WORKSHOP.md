# 3D 工坊维护约束

## 数据与接口

- 契约：`packages/contracts/src/model3d.ts`。服务：`apps/server/src/model3d/engine.ts`。工程规范数据在 `Documents/Aha/Models3D/`，不依赖精灵工程格式或数据库迁移。
- `model3d.list/get/command/forThread` 与事件流复用现有 Effect RPC。资产读取在 `/api/model3d/assets/<projectId>/<versionId>/<file>`，沿用启动令牌或认证会话。变更命令要求 owner 会话。
- 版本发布前必须通过实际 GLB 的 glTF Validator、容量检查和 SHA-256。任务输入与发布记录先落盘、版本目录不可覆盖。每工程串行写入，修订号防止并发覆盖；requestId 与内容指纹保证重复提交可识别。
- 预览指针与采用指针独立。当前预览供下一轮 AI 上下文使用，导出和资源入库只使用采用指针。任务失败、取消与恢复都不能隐式调用新 AI 轮次。
- Agent Gateway 的 `model3d` 只开放 get/submit/status/report，校验活跃会话和轮次。采用、导出、归档只在工作台。对话开始前绑定工程；`ProviderCommandReactor` 每轮注入规则，删除会话解除绑定。

## 桌面运行边界

- `apps/desktop/src/model3d/host.ts` 提供随机凭据认证的本机 Host HTTP，使用私有 UNIX socket / named pipe。请求只传工程与任务 ID；大模型和贴图通过受控工程目录交换，不进入聊天文本或大型 RPC。
- Three.js 固定版本 0.186.1，Vite 独立构建 `model3d-runtime.html` 与内联 Worker。专用 BrowserWindow 开启 Electron sandbox/contextIsolation，关闭 Node（包括 Worker），没有主应用 bridge、认证信息或持久会话。生成代码仅在 Worker 执行，CSP 只允许进程内 `data:`/`blob:` 读取，禁止网络和文件连接；宿主只允许启动阶段加载同源静态代码。超时销毁 Worker/专用进程。
- Worker 输出仅接受有限 BufferGeometry、标准材质、Group/Object3D/Mesh。验证属性、索引、变换、容量和层级后才交给可信 Three.js 层；不接受灯光、相机、纹理 URL、动画、骨骼或外部包。
- 可信层负责本地贴图、PBR 通道、统计、GLTFExporter、缩略图。GLTFLoader 即使返回场景，也必须检查内嵌纹理是否成功解码，不能发布无贴图的降级结果。查看器和导出读取同一份规范 GLB；显示网格、灯光、相机不进入资产。查看器按需绘制并释放几何、材质、贴图、辅助对象和 renderer。
- Blender 固定 mcp-for-blender 2.2.2 和同包 addon，uvx/Python/缓存/配置在 Aha 私有运行目录。独立 GUI 使用 factory startup、disable-autoexec、环回端口和工程标识；经 MCP SDK stdio Client 连接。开启上游 safe mode，关闭遥测及资产服务，只调用场景读取和 Python 建模/固定发布脚本。
- 单次 Python 调用 120 秒，整体任务另有宿主超时。取消/崩溃/超时只使用 Aha 保存的 ChildProcess 句柄，禁止按进程名终止 Blender。工程隔离不等于 OS 沙箱。生成源码另经 AST 发布规则检查，拒绝文件操作、发布路径、动态属性访问和窗口管理；这不是通用 Python 安全沙箱。固定发布脚本决定规范保存路径，保存 `.blend` 后发布 GLB；不能自动重放不明 Python 操作。
- GLB 可进入 Blender 作为派生版本；Blender 派生网格不还原 Three.js 源码。原始版本与源码继续保留。

## UI、导出和资源中心

- 沿用 `docs/UI_GUIDELINES.md`、公共外壳/控件/图标/翻译和语义字号。导航新增 `model3d`，默认插在精灵动画后；保留定制顺序与隐藏状态。窄窗口使用 Sheet，不能为列表中每个模型创建 WebGL。
- 导入 glTF 时将完整本地依赖嵌入，拒绝 URL、绝对路径、目录逃逸、缺失资源及超容文件。纹理规范为本地 PNG；Base Color sRGB，其余数据纹理线性；粗糙度在 G、金属度在 B。
- 导出使用采用版本、实际哈希和检查报告，临时目录完成后 rename，新目录避免覆盖。源码包包含必要父版本源码与引用贴图；GLB 内嵌纹理，无本地外部路径。Godot 预设使用通用 GLB，清单明确 LOD/碰撞体未提供。
- 资源中心增加 `model3d` 类型和来源（projectId/versionId）。入库沿用持久化 collection receipt、目标稳定身份、哈希、独占复制和失败重试；来源恢复用不可变版本资产 URL，不能调用 AI。模型源版本没有自动 GC。

## 核心回归

```sh
bun run test apps/server/src/model3d apps/server/src/agentGateway/model3dTools.test.ts apps/desktop/src/model3d apps/desktop/src/resources packages/shared/src/ahaUserDirectories.test.ts apps/web/src/components/resources apps/web/src/aha/translations.test.ts
bun run --cwd apps/web test:browser src/components/model3d
bun run typecheck
bun run build:desktop
```

独立 Electron 执行验收、真实 AI 会话与本机 Godot 验证写入 `.tmp/`；模拟宿主测试只证明状态机，不能代替实际 Worker、MCP 与游戏引擎导入。正式打包仍需用户单独请求。
