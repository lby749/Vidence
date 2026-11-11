# 验收说明

2026-11-11 的源码检查：24个Vitest文件、145项测试通过；TypeScript通过；17项Python检查通过。最终构建与包检查以本机最新 artifacts 报告为准。

- knowledge-qa-check：真实V4.1 Flash和原图像素，有图/无图/换图三项通过；没有用字幕或手写答案替代图像。
- knowledge-frame-review：三个B站原视频的全部候选图和本地片尾对照，共135张完成真实分类。
- knowledge-ui-check：无界面桌面UI，使用真实原图和已生成的真实模型结果作为预置数据。图片开关、引用原图预览、过滤/待确认分区、人工恢复及用户提供的品牌图标通过。它不是Qt实际播放证明。
- sidebar-layout-check：右侧来源面板、模型选择、多语言和来源/草稿保留的无账号UI检查。
- desktop-keyframes-check --no-ocr：原媒体及持续运动生成片分别验证，无OCR/无模型下载仍真正保存1920宽原图；生成片不能冒充原媒体。
- player-controls-check：本机实际Qt窗口，暂停、进度、音量、底部全屏、Esc恢复侧栏、自动隐藏和退出全屏通过；网页平台原生全屏仍需分别验证。
- portable-release-check：从最终ZIP解压到新目录，移除系统Python/Node路径后检查随包运行时、桥接和扩展。

测试媒体在独立浏览器或内存数据库中运行，测试后关闭。真实B站原媒体使用本地缓存重放，不把它写成日常登录账号网页端完整验收。

尚未验收：物理空白Windows及真实缺少WebView2的安装、全部网页原生全屏场景、Apple/AMD实机、所有平台账号流程。Android、TTS、听视频ASR未实现，iPhone暂缓。不能依据一个检查层替代另一个。

## Vidence BETA.3 云端与公开验收

更名后的目标源码ff7d3895df74759cff31bd46461ad9c7bb160b19，版本0.1.0-beta.3。[完整云端运行42982169455](https://github.com/lby749/Vidence/actions/runs/42982169455)的source、windows-build、windows-runtime和release四项均通过。

- Linux与Windows从干净检出重新安装锁定依赖，145项Vitest、TypeScript和生产构建通过；Windows另有17项Python检查。侧栏、设置、三语言更新/反馈界面、扩展闭环与桥接通过各自检查。
- 原生720p60、1080p59.94/29.97、4K23.976/60的H264解码交付通过；高清存档3840宽，预览1280宽；持续运动生成片无OCR记录检查通过。
- 另一台Windows runner运行同一份冻结成品，目标PATH仅System32，未安装项目开发依赖：真实解码225帧、3733ms、1280×720，两次像素取样不同，包内Node桥接通过。不将此写成最终显示器呈现率。
- 云端检查完成后发布[Vidence BETA.3](https://github.com/lby749/Vidence/releases/tag/v0.1.0-beta.3)。文件名Vidence-Windows-x64.zip，359145894字节，SHA-256为bb8bf042431cc52d04ed211f29887b226dca0126860de4308ca1ea7dfef053a8。
- 新更新服务源码在独立浏览器中匿名访问Vidence真实发布API，HTTP200，能读取本版且不重复推荐已安装版本；更新与反馈UI另用隔离目录验证可推荐、暂缓、关闭及手动重试。真实网络检查不说成已安装旧版EXE的更新UI验收。
- 本机新版EXE实际启动，界面标题Vidence，右侧学习栏与视频真实解码通过；测试结束暂停并关闭。3488个本机成品文件搬移后逐个哈希匹配，两个EXE内嵌代码与当前Python源码一致，41个前端文件与当前生产构建一致，保留250份原始依赖声明。

仓库已确认公开、MIT、Issues开启，应用和文档使用新的反馈地址。更名保留原学习数据目录。BETA.1/BETA.2需手动安装一次新版，不宣称旧地址仍能自动更新。

原生窗口与无界面测试不会覆盖全部用户流程；英文界面仍有少量动态计数字样未完整翻译。物理空白Windows、真实缺少WebView2安装、Apple/AMD实机及其他未覆盖项目仍按上面的边界标注。

## BETA.2 云端与公开验收（更名前历史记录）

目标源码834d0ae6a92bd1792592e13b97699b08f3f6558a，版本0.1.0-beta.2。[完整云端运行42977214404](https://github.com/lby749/Vidence/actions/runs/42977214404)的source、windows-build、windows-runtime和release四项均通过。

- Linux：从干净检出npm ci，TypeScript、144项Vitest、生产构建、扩展记录/检索/导出闭环、三语言侧栏及更新/反馈界面和桥接。
- Windows：新装开发依赖，144项Vitest、17项Python，设置/侧栏/更新与反馈UI，720p60、1080p59.94/29.97、4K23.976/60，3840宽存档和持续运动片无OCR记录，随后生成独立包。
- 另一台Windows runner：不安装项目开发依赖，目标PATH仅System32；冻结程序用包内Qt实际解码720p H264，227帧、3733ms、1280×720、两次不同像素取样，并通过包内Node桥接。该结果证明真实解码，不代表显示器最终呈现率。
- 发布：以上检查完成后，才生成[BETA.2包与SHA-256文件](https://github.com/lby749/Vidence/releases/tag/v0.1.0-beta.2)。发布资产SHA-256为9ac18f3a04f2e6ac5175ce61be8a893f54de85b90e9fccd6f5781780ea70cd4e，不包含模型权重或用户数据。

2026-11-11在仓库更名前已核对public、Issues开启，发布页和反馈页匿名可见，下载入口HTTP200。取已发布BETA.1的更新服务源码，在独立浏览器中匿名访问当时真实发布API，实际发现BETA.2；既没有伪造Release，也没有用模拟目录冒充真实网络。此项是旧版源码的浏览器运行，不说成已安装旧版EXE的UI验收。更名后旧包的API会发生重定向，需要手动安装一次Vidence新版，不能用更名前结果宣称旧地址仍可自动更新。模型/原媒体检查仍是上面的本机证据层。

托管runner预装Python/Node/WebView2，因此不能把PATH隔离和冻结程序解码说成物理卸载全部软件，真实缺少WebView2的安装仍未验证。Codex云任务的原始基线检查曾受浏览器下载域名策略限制；后续GitHub云端已完成对应浏览器检查，不掩盖两种环境的差异。

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/Vidence)，谢谢！
