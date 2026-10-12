# 独立绘图工作台

左侧“绘图”进入 `/drawing`。设置中的“生图供应商”独立于 Agent 供应商；先配置 API 根路径、模型和可选 Key，再在工作台选择供应商／模型。Base URL 保留用户路径，不自动添加 `/v1`，允许明确配置本机和内网 API。模型探测不会调用生成；“测试生图”和“重新生成”会创建新任务，并可能产生费用。

首版支持 OpenAI 兼容 Images API：无参考图使用 JSON `/images/generations`，有参考图使用 multipart `/images/edits`，遮罩作用于第一张图。参数默认值省略，明确选择的值完整发送，不根据模型名称删除字段或自动重试。透明背景需要明确选择 PNG 或 WebP。

参考图支持文件、拖入和粘贴，最多 16 张、20 MiB／张、80 MiB／任务。画板以底图原始坐标记录画笔、橡皮、文字、箭头、矩形命令，支持撤销／重做和缩放／平移；导出后是扁平 PNG。遮罩的红色涂抹区域表示需重新生成，导出为透明 alpha，保留区域为不透明 alpha。更换第一张参考图会清除遮罩。原文件保留，编辑底图按 EXIF 方向归一。

每个供应商独立 FIFO 排队，默认并发 2，可配置 1–8；保存完成前占用并发名额。任务刷新或切页继续执行。`clientRequestId` 唯一约束避免相同提交重复调用。生成 POST 不自动重试；超时、断网或上游错误由用户手动决定是否重新生成。运行中取消中止本地请求，供应商仍可能处理或计费。

重启后排队任务继续，已经发出的请求标为中断。保存中的任务使用本地结果清单与逐项保存检查点恢复，不重新生成。排队期间连接或 Key 变化会失败为 `provider_changed`；停用供应商暂停其队列。存在非终态任务时不能删除供应商。

历史全局独立于项目／会话，每页 30 项。图片保存在 `<stateDir>/drawing/assets/`，结果 URL 立即由服务端下载。下载不携带供应商 Authorization，验证公网目标地址、固定连接地址、防止私网重定向并限制大小。图片由 sharp 验证、读取尺寸、方向归一并生成缩略图；文件原子写入。SQLite 迁移 135 添加绘图表；v1.0.1 绘图开发版的 132 记录通过迁移别名兼容，保留旧表和数据，并补跑 Synara 132–134。任务、草稿通过关联引用图片；来源任务删除不会破坏后续任务或草稿的图片。未被引用的上传 24 小时后清理。

API Key 由现有 ServerSecretStore 保存；供应商读取只返回是否配置，任务不保存 Key。该存储依赖私有目录和文件权限，不是加密保险库。

## 自动化验证

单元与 SQLite 集成测试（无需网络或真实 Key）：

```sh
bun run test apps/server/src/imageGeneration apps/web/src/components/drawing/imageCanvas.test.ts
```

可重复运行的浏览器集成测试只允许 loopback 目标和本地 mock，默认跳过。必须使用独立数据目录，测试通过 UI 新建并显式选择它的 mock 供应商。测试会留下少量 mock 供应商及历史供检查，不重置库。

两个终端启动隔离 app 和 mock：

```sh
bun run dev --home-dir /private/tmp/aha-drawing-e2e --port 5797 --no-browser
node apps/server/src/imageGeneration/testing/mockProvider.mjs
```

再运行（按 dev 输出调整端口）：

```sh
AHA_DRAWING_E2E_URL=http://localhost:5733/drawing \
AHA_DRAWING_E2E_MOCK_URL=http://127.0.0.1:5798 \
bun run test apps/web/src/components/drawing/drawing.e2e.test.ts
```

已安装 Chrome 时可添加 `AHA_DRAWING_E2E_CHROME=1`；否则使用 Playwright 自己的 Chromium。mock 仅绘制本地 SVG，不接入任何付费 API。用 `AHA_DRAWING_MOCK_PORT` 可改变 mock 端口。测试检查供应商探测、多图、下载、标注、遮罩 multipart、刷新、429 不重试、确认删除、窄窗口及深浅主题，截图写入 `.smoke/drawing/`。普通 web 测试目标不提供桌面原生语言切换桥接，英文桌面交互仍需在桌面端验收。真实模型兼容性需用户在设置中通过显式测试或生成操作验证。

构建原生依赖验证：`bun run build:desktop`，然后 `node apps/server/dist/runtimeDependencySmoke.mjs`。该冒烟会实际调用 sharp 生成和解码 PNG。完整分发还需现有 desktop artifact 流程完成 Cua Driver 固定源码构建及打包，不能以普通构建或冒烟代替 `.app` 验证。

生成 macOS arm64 `.app` 后，再使用包内 Electron 验证实际分发依赖：

```sh
ELECTRON_RUN_AS_NODE=1 release/mac-arm64/Aha.app/Contents/MacOS/Aha \
  release/mac-arm64/Aha.app/Contents/Resources/app.asar/apps/server/dist/runtimeDependencySmoke.mjs
```

本次已完成该分发冒烟，包内 sharp 实际生成和解码 PNG 成功。真实供应商和英文桌面交互的验证限制仍如上所述。
