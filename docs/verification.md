# 验收说明

2026-11-11 的源码检查：24个Vitest文件、144项测试通过；TypeScript通过；17项Python检查通过。最终构建与包检查以本机最新 artifacts 报告为准。

- knowledge-qa-check：真实V4.1 Flash和原图像素，有图/无图/换图三项通过；没有用字幕或手写答案替代图像。
- knowledge-frame-review：三个B站原视频的全部候选图和本地片尾对照，共135张完成真实分类。
- knowledge-ui-check：无界面桌面UI，使用真实原图和已生成的真实模型结果作为预置数据。图片开关、引用原图预览、过滤/待确认分区、人工恢复及用户提供的品牌图标通过。它不是Qt实际播放证明。
- sidebar-layout-check：右侧来源面板、模型选择、多语言和来源/草稿保留的无账号UI检查。
- desktop-keyframes-check --no-ocr：原媒体及持续运动生成片分别验证，无OCR/无模型下载仍真正保存1920宽原图；生成片不能冒充原媒体。
- player-controls-check：本机实际Qt窗口，暂停、进度、音量、底部全屏、Esc恢复侧栏、自动隐藏和退出全屏通过；网页平台原生全屏仍需分别验证。
- portable-release-check：从最终ZIP解压到新目录，移除系统Python/Node路径后检查随包运行时、桥接和扩展。

测试媒体在独立浏览器或内存数据库中运行，测试后关闭。真实B站原媒体使用本地缓存重放，不把它写成日常登录账号网页端完整验收。

尚未验收：全新Windows虚拟机、真实缺少WebView2的安装、最新全部原生全屏场景、Apple/AMD实机、所有平台账号流程、Android、TTS、听视频ASR。不能依据一个检查层替代另一个。
