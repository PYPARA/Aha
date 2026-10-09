# 芙宁娜·众水之歌 / Furina · Chanson of Many Waters

Aha 可选内置皮肤；应用名称仍为 Aha，基础安装图标仍使用阿哈。用户在外观中的皮肤库选择、预览并应用后，运行时图标、共享 Logo、favicon、五区域背景和深浅配色一起更新。

## 来源与生成记录

角色参考：[HoYoWiki 官方资料](https://wiki.hoyolab.com/pc/genshin/entry/4376)、[官方角色预告](https://genshin.hoyoverse.com/en/news/detail/113484)。实际图像参考采用游戏立绘镜像 [Enka](https://enka.network/ui/UI_Gacha_AvatarImg_Furina.png)。采用荒性短发、蓝黑服装、礼帽与异色眼；生成结果中头发为银白色、带蓝色阴影与发尾。

2026-10-10 使用 imagegen 原官方 CLI，用户授权的当前会话兼容服务和 `gpt-image-2.5`。六次请求逐张执行，图标 high、其余 medium，`size=auto`，SDK `max_retries=0`，timeout 180s。全部首次成功；没有付费重试，也没有 Codex/Claude 主会话验证请求。鉴权只进入进程环境，未记录密钥或凭证。

原始输出、参考、完整提示词及实际参数保存在 `output/imagegen/furina/`（本地忽略目录，未进入 Git）。该目录的 `generation.json` 是完整六次记录。

| 素材     | 实际生成尺寸 | 最终尺寸  | 用途                         |
| -------- | ------------ | --------- | ---------------------------- |
| icon     | 1254×1254    | 1024×1024 | 头肩近景，礼帽、脸部、异色眼 |
| window   | 1672×940     | 2048×1152 | 人物靠右，左/中央低细节      |
| rail     | 768×2048     | 768×2048  | 纵向水光，无人物面部         |
| sidebar  | 887×1774     | 1024×2048 | 深蓝平静列表区域，下方装饰   |
| content  | 1672×941     | 2048×1152 | 中央留白，边缘水光           |
| composer | 2048×768     | 2048×768  | 横向低对比光带，装饰靠边     |

本地处理脚本：`apps/desktop/scripts/prepare-furina.ts`。母版 `icon-master.png`；透明圆角 `icon.png`；附带 ICNS、ICO、16/32px favicon 和 180px Apple Touch Icon。处理无需图片 API。

五张背景复用静态图片归一化；单图 20MB/32MP，SHA-256 内容寻址。`verification.json` 保存最终 PNG 尺寸、字节数和哈希。最大背景约 4.0MiB，全部可解码且低于限制。运行时资源在 `apps/desktop/resources/aha/furina/`，manifest 只引用固定哈希；无任意文件路径 IPC。

逐张检查了人物一致性和文字留白。图标帽尖略触及上边缘，小尺寸保留脸、礼帽和蓝白轮廓；五区域不重复大幅人物。`preview.png` 为六张最终素材合览，排列为图标、窗口、功能栏、会话侧栏、内容区、输入框。

浅色：浅蓝白底 / 深蓝文字 / 蓝色强调。深色：深海蓝底 / 浅色文字 / 水蓝强调。背景默认不透明度 window .48、rail .20、sidebar .23、content .16、composer .18，遮罩 .20，可分别调整并保存到本套皮肤。
