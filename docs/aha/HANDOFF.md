# Aha handoff — 2026-10-10

## 结果与操作

本轮已实现「默认样式」、外观右上角重置，以及「芙宁娜·众水之歌」及可持久切换的皮肤库。打开普通 Aha → 设置 → 外观 → 皮肤库，选择默认样式/阿哈/芙宁娜/导入项，预览后点击应用。皮肤替换图标、五区背景和两套 chrome 配色；品牌文字仍为 Aha。导入成功即进入库，取消不会删除导入项。

「默认样式」使用 Synara 原始深浅颜色、五区无背景、Aha 图标。外观右上角「恢复默认」立即应用这套原始定义；其他皮肤的调整和全局语言/字体/主题模式/材质/代码高亮保留。皮肤选择行仍走预览/取消/应用，右上角重置丢弃当前预览，失败保留已应用配置。

App icon 仅显示当前皮肤有效图标，点击重新应用已保存图标，不提供 Synara 图标。补充图标在应用后才改变 Dock/Finder；预览不会切换原生图标。内置不能删除/重命名；当前导入项要先切换到别的皮肤才能删除。旧包无图标继续使用继承语义，每次切换基于切换前的实际图标，并持久保存该有效值。

- 开发包：`release/Aha-default-skin-dev-1.0.1-mac-arm64.zip`。旧的 skins/elation/icon-fix/dev ZIP 均保留。
- 可单独导入：`release/Furina-Chanson.skin.json`（v4，约21MiB，六张图片）。
- 素材原始记录：`output/imagegen/furina/`；最终素材与合览：`assets/aha/furina/`；随包资源：`apps/desktop/resources/aha/furina/`。

## 后续修改入口

| 模块                           | 文件                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 跨进程数据与 v4 包             | `packages/contracts/src/ahaSkins.ts`、`ahaChannels.ts`、`ahaAppearance.ts`                                                                       |
| 皮肤库、原子持久化、兼容/去重  | `apps/desktop/src/aha/skin-library.ts`                                                                                                           |
| 内置与旧包颜色转换             | `apps/desktop/src/aha/skin-palettes.ts`                                                                                                          |
| 信任校验、原生选择器、事件广播 | `apps/desktop/src/aha/appearance-ipc.ts`、`apps/desktop/src/preload.ts`                                                                          |
| Dock/Finder 与启动恢复         | `apps/desktop/src/main.ts`（沿用既有 native icon queue / macAppIcon）                                                                            |
| 设置/状态/图标/favicon         | `apps/web/src/aha/AppearancePanel.tsx`、`AppearanceProvider.tsx`、`skin-colors.ts`                                                               |
| 临时颜色事务                   | `apps/web/src/hooks/useTheme.ts`：begin/preview/cancel/apply；颜色编辑先进入临时状态，全局字体/模式/材质/代码主题仍保存；取消/离开只撤销颜色草稿 |
| 共享 Logo / 重新应用行         | `apps/web/src/components/SynaraLogo.tsx`、`components/settings/AppIconPicker.tsx`                                                                |
| 本地处理生成原图               | `apps/desktop/scripts/prepare-furina.ts`                                                                                                         |

默认安装与基础打包图标保持阿哈；运行时皮肤图标来自已验证内容寻址图片。macOS 仅定制独立 App bundle，不修改共享 Electron 程序。AHA_HOME 显式设置时 Electron profile 位于该目录的 electron-profile，后台仍在 userdata。未设置时默认用户目录不迁移。

## 已验证与边界

检查细节见 STATUS。当前精简树的全套 Vitest 22/22；Chromium 8/8（皮肤设置、迟到响应、真实 useTheme、补图标保留预览颜色、颜色取消/应用、全局 mode/font 独立持久化）；typecheck 7/7、fmt 通过、lint 0 errors。

本次默认样式 macOS arm64 独立副本已实测选择/预览/取消/应用、调整默认色后在芙宁娜预览中点击右上角恢复原始默认、五区 off、全局模式/字重及其他皮肤调整保留、重启、Dock bitmap 与 Aha 有效图标一致；Finder 平均每通道差 0.002312/255。首次空 profile 有一次设置控件就绪等待超时；同一独立 profile 重启后冒烟通过，未声称修复启动流程。

原芙宁娜 macOS arm64 独立数据与测试 App 副本实测了真实设置预览/取消/应用、阿哈↔芙宁娜↔导入项、补图标保留预览颜色、各套不透明度记忆、默认恢复、v4 导出去重/导入取消保留、Dock bitmap 一致、Finder 自动重启恢复（平均每通道差0.000507/255）、深色模式切换保持。原生文件选择器通过固定本地路径测试桩验证接口，未自动化文件对话框本身。预览颜色已接入真实 theme snapshot，防止补图标时草稿退回旧配色；配色编辑不会在点击应用前写入已保存皮肤。

本次默认样式检查与 macOS 冒烟记录在 `.tmp/default-skin/`；原芙宁娜测试用 `.tmp/furina/`，没有读取旧聊天或用户生产 SQLite。进程重启测试退出独立 app，未宣称正常关闭完整生命周期验证；消息输入/流式测量没有运行真实 provider 会话，背景不拦截点击沿用现有 CSS。Windows/Linux 原生图标、签名、公证和发布未验证；精简树已删除历史上游测试/Windows runtime 检查入口，未编造通过结果。

图片六次请求全部成功，无自动付费重试。当前会话凭证只进入官方 CLI 的内存环境，未写入仓库。没有 Codex/Claude 主会话调用。用户后续授权在 main 将本轮源码、素材、验证与文档合并为一次本地提交；不推送或发布。本地忽略的生成原始记录、测试 profile 与开发 ZIP 不进入提交。

## 下一任务

本轮功能范围结束。后续可单独推进 Windows/Linux 的原生图标验证、正常退出生命周期检查及恢复精简树历史测试覆盖。无需再生成芙宁娜图片；再次付费生成或 provider 会话验证需新的授权。
