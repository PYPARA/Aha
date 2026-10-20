# Aha

<img src="apps/web/public/aha-logo.png" alt="Aha 图标" width="96" />

Aha 是基于 [Synara](https://github.com/Emanuele-web04/synara) 二次开发的本地编程 Agent 工作台，当前源码已合入 **Synara v1.0.7**。原基线、历次合并提交和数据库兼容信息见 [UPSTREAM.md](UPSTREAM.md)。

支持项目与聊天、供应商会话、Git、编辑器、终端、浏览器及自动化，并提供 Aha 中文界面、五区背景与内置皮肤、绘图工作台、精灵动画工作台和资源中心。供应商能力取决于本地运行时、账号和权限。

## 开发与构建

需要 Bun **1.4.2**、Node.js **24.13.1** 及对应平台原生工具链；macOS 原生构建需要 Xcode。

```sh
bun install --frozen-lockfile
bun run aha:dev
```

```sh
bun run aha:build
bun run aha:package
```

`aha:package` 默认生成 macOS Apple Silicon 正式版，产物为 `release/mac-arm64/Aha.app`。其他平台的本地构建入口保留在根 package.json 中。

核心回归及源码检查：

```sh
bun run test
bun run --cwd apps/web test:browser
bun run typecheck
bun run fmt:check
bun run lint
```

绘图和精灵本机 E2E 需要显式指定独立测试服务与本机 mock；普通测试运行会跳过这两项。

## 设置与数据

先安装并认证准备使用的供应商运行时，再在 Aha 设置中选择账号、供应商和模型。语言、背景和主题位于 **设置 → 外观 → Aha 背景与语言**。

正式应用默认使用 `~/.aha-next`，`aha:dev` 使用仓库内 `.aha-dev`。独立服务支持 `AHA_HOME` 或 `--home-dir` 指定数据目录。Aha 使用独立应用身份与 `aha-next:` 协议，关闭官方 Synara 自动更新、渠道安装和诊断上传。

## 文档

功能使用说明与开发约定统一放在 [docs](docs/README.md)，包括 [精灵动画工作台](docs/guides/SPRITE_WORKFLOW.md)、[资源中心](docs/guides/RESOURCE_CENTER.md) 和 [UI 实现规则](docs/UI_GUIDELINES.md)。上游版本及精简边界见 [UPSTREAM.md](UPSTREAM.md)。

## 来源与许可

保留上游内部包名及兼容标识。项目采用 [MIT License](LICENSE)，原生 CUA 组件遵循 [CUA 许可证](licenses/CUA-LICENSE.txt)，绘图组件的第三方声明见 [gpt-image-playground](third-party-licenses/gpt-image-playground.txt)。
