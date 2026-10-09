# Aha

<img src="apps/web/public/aha-logo.png" alt="Aha 图标" width="96" />

Aha 是基于 [Synara](https://github.com/Emanuele-web04/synara) 二次开发的本地编程 Agent 工作台，将项目、对话、供应商会话和开发工具放在一个桌面应用中。当前源码基线为 Synara **v1.0.1**。

## 可以做什么

- 管理项目与对话，选择供应商和模型，查看代码变更、文件、编辑器与 Git。
- 在任务中使用终端和浏览器，管理 Tasks、Hubs、工作树、供应商切换与自动化。
- 使用核心中文/英文界面，调整字体、字号、字重、主题与材质；部分界面仍保留英文。
- 自定义窗口、功能栏、侧栏、内容区和输入区的背景，使用清晰模式、主题包和内置「虚照 · 欢愉」套装。

## 运行

需要 Bun **1.4.2** 和 Node.js **24.13.1**。在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run aha:dev
```

源码编译和 macOS arm64 本地打包命令：

```sh
bun run aha:build
bun run aha:package
```

原生构建需要相应平台工具链；macOS 需要 Xcode。其他平台的构建入口在根 package.json 中。官网源码保留在 apps/marketing，可使用 `bun run dev:marketing` 单独运行。

## 供应商与外观

先安装并认证准备使用的本地供应商运行时，再在 Aha 的设置中配置账号，在对话中选择供应商和模型。保留 Codex、Claude、OpenCode 等上游集成；可用能力取决于相应运行时、账号和权限。

背景与语言位于 **设置 → 外观 → Aha 背景与语言**。可预览背景或导入主题包，确认后应用；取消预览会恢复原外观。内置背景不会自动覆盖现有设置。应用图标使用「Aha · 虚照·欢愉」。

## 数据与版本

普通应用使用 `~/.aha-next`，开发入口使用仓库内 `.aha-dev`；可通过 `AHA_HOME` 指定独立目录。Aha 使用独立应用身份和 profile，关闭官方 Synara 自动更新、渠道安装和诊断上传。不会自动导入历史聊天数据。

本地已有 v1.0.1 图标修复开发包，旧 beta.2 开发包也继续保留在 release/。这些是本地开发产物；本仓库未提供正式下载发布。

## 来源与许可

保留 Synara 的内部包名、核心实现与许可。Aha 扩展集中在品牌、独立身份、双语和外观模块。

项目采用 [MIT License](LICENSE)。原生 CUA 组件保留 [CUA 许可证](licenses/CUA-LICENSE.txt) 和对应版权声明。
