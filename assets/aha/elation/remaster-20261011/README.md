# 虚照头像更新（2026-10-12）

后续完整背景版本现已交付，见 `../remaster-20261012/README.md`；下文保留本阶段历史记录。

直接使用用户上传的 480×480 RGB 头像，不改变人物；放大到 1024px 仅用于图标尺寸，不增加原始细节。几何圆角蒙版和外部透明边距通过本地处理产生；没有按黑色像素抠图。PNG、ICNS、ICO、16/32px favicon、180px Apple Touch Icon 已导出。`verification.json` 记录实际大小与 PNG SHA-256。

运行时使用 `apps/desktop/resources/aha/elation/icon.png`。基础安装图标仍用旧 `assets/aha/elation/icon.png`，旧素材保留。已有活动皮肤不自动更换；下次预览并应用虚照时使用上传头像。

新版背景尚未交付，当前随包仍为旧五张背景。第 3 次图片请求（虚照内容图）收到 HTTP 524，停止后续付费请求且未重试。原始参考、提示词及请求记录在忽略目录 `output/imagegen/remaster-20261011/`。

参考核实：崩坏星穹铁道认证账号发布的 [「星神★阿哈」图文](https://www.bilibili.com/opus/1248516077785186355)；发布账号 mid 1340190821，认证类型 1。官方参考画面用于未成功的内容图请求，上传头像的来源身份未额外认定。
