# Aha 存储规则

Aha 按独立的新软件运行。新内容直接使用 Aha 自己的存储规则；不扫描、复制或导入 Synara 的工作目录，不生成工作目录迁移清单，不提供迁移状态或重试接口。通用设置不展示存储位置与迁移面板。

## 用户工作文件

默认目录由 `packages/shared/src/ahaUserDirectories.ts` 统一定义。桌面端采用系统文稿目录，并通过 `AHA_DOCUMENTS_DIR` 传给服务端；独立服务端默认使用用户主目录下的 Documents。

| 内容             | 默认位置                                | 创建时机                               |
| ---------------- | --------------------------------------- | -------------------------------------- |
| 普通聊天工作文件 | `Documents/Aha/Chats/<日期>/<会话目录>` | 创建对应聊天工作区时                   |
| Studio 工作文件  | `Documents/Aha/Studio`                  | 使用 Studio 工作区时                   |
| Groups 工作文件  | `Documents/Aha/Groups` 下的工作区       | 创建对应 Group 工作区时                |
| 资源中心         | `Documents/Aha/Resource`                | 桌面首次初始化资源库且没有已保存配置时 |

路径解析本身不创建目录。服务端启动不为迁移预先建立 Chats、Studio、Groups 空目录。用户选择的代码项目和自定义工作文件夹按实际路径使用。

资源中心仍可在其页面内切换资源库或在文件管理器中打开。已有自选库优先；离线或暂时不可用时不自动切换为空库。切换资源库只选择另一个库，不搬动原库文件。

## 内部应用数据

macOS 正式桌面版默认后端根目录为 `~/.aha-next`，状态目录为其下的 `userdata`。开发服务使用 `dev`；运行渠道和启动配置可以覆盖根目录。

- `state.sqlite`：聊天、项目、事件、自动化、绘图任务及相关持久记录。
- `attachments/`、`settings.json`、`keybindings.json`、`secrets/`、`logs/`：附件、配置、私有凭据及日志。
- `drawing/`：绘图图片、缩略图及保存恢复数据。
- `sprites/`：精灵动画生成上下文和会话关联；可编辑项目目前另存在客户端 IndexedDB，见 `docs/sprite-animation.md`。
- `project-context/`：项目与 Group 上下文、默认资料库。
- Aha 外观配置、皮肤、背景、图标：保存在状态目录下对应文件或子目录。
- 托管 Git worktree：应用根目录下的 `worktrees/`，沿用既有 Git 工作区管理。

Electron profile 默认在 `~/Library/Application Support/aha-next`，保存客户端界面状态、浏览器会话、Local Storage 和 IndexedDB 等。显式设置 `AHA_HOME` 时，桌面 profile 使用该根目录下的 `electron-profile`。这不会自动移动文稿工作目录或自选资源库。

`Chats` 是工作文件目录，不是聊天记录数据库；`Documents/Aha` 也不是完整的应用数据备份。导出文件保存到下载或保存流程指定的位置，只有主动收藏才进入资源中心。

## 与旧目录的关系

应用不将 Synara 的目录当作待迁移来源，不改写旧文件链接，也不因检测到主目录或旧目录而显示待处理提示。用户显式打开的文件夹仍按一般项目规则处理。

移除工作目录迁移功能不会删除磁盘上已经存在的文件、空目录、数据库或历史迁移清单，也不会重置已有会话的实际路径。应用自身正常的数据库 schema 升级与恢复机制保留，它们与 Synara 工作文件迁移是不同的功能。

目录规则测试位于 `packages/shared/src/ahaUserDirectories.test.ts`；资源库默认值与自选库行为由桌面资源库测试覆盖。
