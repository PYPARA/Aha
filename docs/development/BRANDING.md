# 品牌与界面语言

Aha 保留上游 Synara 的内部包名、类型名和协议标识，用户看到的产品名、链接和语言由 Aha 统一管理。上游合并时按以下规则处理。

## 产品名

- 品牌常量放在 `packages/shared/src/ahaBrand.ts`：`PRODUCT_DISPLAY_NAME`、`PRODUCT_HOMEPAGE_URL`、`UPSTREAM_BASELINE`（随合并与 `UPSTREAM.md` 一起更新）。
- i18next 目录（`packages/shared/src/locales/`）保持上游原文，不手工改写；Web 端和桌面端的 i18next 实例都通过 `applyAhaBrand` 后处理，把目录输出里的 Synara 换成 Aha。用户、模型和工具传来的数据不做替换。
- 尚未转成词条的字面量文案、原生弹窗、macOS 权限提示（`scripts/lib/desktop-platform-build-config.ts`、`apps/desktop/scripts/electron-launcher.mjs`、`apps/desktop/resources/localizations/*.lproj`）及原生 helper 文案直接写 Aha。合并后用下列命令复查，结果只应剩内部标识、注释和休眠的 Beta 频道代码：

  ```bash
  git grep -n -E "(^|[^@./A-Za-z0-9_-])Synara([ ’'.,!?)]|$)" -- apps packages scripts ':!*.test.*' ':!*.browser.tsx' ':!*/locales/*'
  ```

- 保持不变：`@synara/*` 包名、`Synara*` 类型、`SYNARA_*` 环境变量、`synara:` 存储键、`synara_*` 工具名与 MCP server 名、`dev.synara.*` 队列标签、检查点提交作者和终端包装脚本标记。
- `SynaraLogo` 渲染当前皮肤的 Aha 图标；不要重新引入上游 Y 形标志。

## 外部服务

- 不调用上游服务：反馈只有在构建设置 `VITE_FEEDBACK_ENDPOINT` 时才显示；文档、供应商安装指南和新手引导不链接 Synara 官网（`setupDocsHref`、`docsHref` 为空即隐藏）。
- 更新源、诊断上传和 Beta 频道在 Aha 中关闭（`ahaUpdatesEnabled`、`ahaDiagnosticsEnabled`、Beta IPC 拒绝桩），合并时保持。

## 界面语言

- 语言保存在应用设置 `language`（设置 → 通用），默认 `zh-CN`；可选中文、英文或跟随系统，西语目录保留但不可选。正式版不对中文做 Beta 门控，Connectors 仍只在 Beta 开放（`packages/shared/src/betaFeatures.ts`）。
- 上游组件用 `t("ns:key")`；Aha 自有界面可继续传英文原文，`t()` 遇到非词条字符串时查 `apps/web/src/aha/translations.ts`。新增 Aha 文案在该表补中文，不写进上游目录。
- 上游派生的浏览器测试断言英文，`apps/web/vitest.browser.config.ts` 用 `VITE_AHA_DEFAULT_LANGUAGE=system` 保持上游默认；Aha 自己的测试需要中文时显式调用 `setLanguagePreference("zh-CN")`。
