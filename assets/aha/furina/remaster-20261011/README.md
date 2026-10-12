# 芙宁娜头像更新及内容图候选（2026-10-12）

后续完整背景版本现已交付，见 `../remaster-20261012/README.md`；下文保留本阶段历史记录。

官方 HoYoWiki [芙宁娜角色资料](https://wiki.hoyolab.com/pc/genshin/entry/4376) 的画廊原画作为荒性造型参考：[原画 PNG](https://upload-static.hoyoverse.com/hoyolab-wiki/2023/11/08/82021897/21e181e0f362d130d01e212c5bb53b82_5514520376591065301.png)，[辅助肖像 PNG](https://upload-static.hoyoverse.com/hoyolab-wiki/2023/11/08/82021897/263e5ea0784d182b393f67a7e24146a5_6981067474733565531.png)。使用图片输入约束短发、异色眼、蓝黑服装和礼帽，提示词强调清晰线条、分色及赛璐璐阴影，去除厚涂/柔焦描述。生成结果是重绘素材，**不是官方原画**。

用户已接受这张生成头像的帽顶裁切。官方 imagegen CLI、当前会话服务、`gpt-image-2.5`、high、size auto、max_retries=0。头像实际生成 1254×1254，本地缩放为 1024×1024 并导出透明圆角 PNG、ICNS、ICO、16/32px favicon、180px Apple Touch Icon。运行时 `apps/desktop/resources/aha/furina/icon.png` 使用新版；基础安装图标不变。

`content-candidate.png` 是第 2 次成功请求的原始 1672×941 人物内容图候选；人物位于右侧，中央留白。未写入随包背景 manifest。由于第 3 次虚照内容图请求 HTTP 524，全套十张新版背景未完成，后续八次请求停止，当前随包保留旧背景。无付费重试。

完整提示词、参考与请求参数在 `output/imagegen/remaster-20261011/`，导出检查在 `verification.json`，两套图标与小尺寸合览在 `assets/aha/remaster-20261011-preview.png`。
