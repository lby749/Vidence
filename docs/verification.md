# 验收说明

本页说明 Vidence 的哪些使用能力已经实际测试、依据是什么，以及还有哪些情况尚未覆盖。想先了解它能怎样帮助看课和复习，可以阅读[项目介绍](../README.md)；这里保留用于核对的测试细节。

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

## 原生桌面 0.4.3 暂停窗口回归（2026-11-12）

0.4.2 的[独立云端流程](https://github.com/lby749/Vidence/actions/runs/43178535755)已经完成发布，因此保留原发行，新增 0.4.3 修正，不覆盖历史资产。

- 本机 44 项 Python 单元检查、原生 UI 及回环 API 检查通过。
- 外部真实课程媒体窗口已实际挂靠原生侧栏；通过系统窗口采集取得 802×482 的真实课程画面。这不是平台账号或所有课程软件验收。
- 已复现“首次关联已暂停窗口没有首帧”。新增提示后，真实窗口检查得到等待提示，播放后恢复采集；再次暂停、帧龄约 10.4 秒时，手动记录仍保存真实图像。其他视频记录数为零。没有把无画面当作空白截图保存。
- 0.4.3 的自动采样仍跳过过旧画面；初次静止窗口不送首帧时仍需播放片刻，不宣称绕过系统或平台的采集限制。

## 原生桌面 0.4.2 本机验收（2026-11-12）

- 145 项前端检查、41 项 Python 单元检查通过。
- 隔离的原生 UI 检查通过：视频聊天及草稿隔离、三语言、模型实际 ID、取消选源、侧栏真正关闭与重新打开。
- 回环 HTTP 服务验证 API 自动获取聊天模型、完整接口地址归一化、提问栏切换模型后真正使用该 ID 请求，以及错误密钥提示。该检查不冒充真实云端模型。
- 最终冻结成品的实际窗口已点击验证暂停、底部全屏和退出全屏、关闭及重新打开学习栏、原生助手菜单。控制条深色背板可读；全屏画面不再保留侧栏白边。测试后关闭播放器。
- 720p60、1080p59.94/29.97、4K23.976/60 均保持原解码分辨率，回调帧率接近源帧率。3840 宽原图保存检查通过；不将这些数字称为显示器呈现帧率。
- OpenCode Go / DeepSeek V4.1 Flash 的数学原图、有图禁用、换 Excel 原图三组对照重新通过。两段缓存真实 B 站原媒体的采集、OCR、概括、各自长期记忆及限定同视频问答重新通过；聊天与检索未跨视频。不是完整平台账号或整课准确率验收。

发行前还须由本版源码对应的独立云端工作流完成构建、搬移成品及受限 PATH 检查；下文历史基线不能替代该门槛。

## 原生分包基线验收（2026-11-12）

[云端运行43159328392](https://github.com/lby749/Vidence/actions/runs/43159328392)，源码fa1d41ff921fecebcf2646ba9502321d8954c195，Linux源码、Windows构建、另一台Windows成品运行检查均通过。该分支不创建Release。

- 源码：145项前端测试；此基线29项Python检查；插件构建、记录/检索/导出、更新与反馈UI及桥接通过。后续同名课程隔离、原生控件收展和API图片协议补充后，本机Python检查增至38项，BETA.4最终源码仍须重新通过云端。
- 原生UI：Qt Widgets实际构造；视频聊天与草稿隔离、取消选择、三语言及渠道顺序、实际模型ID保存通过。没有用HTML承载桌面界面。
- 媒体：720p60、1080p59.94/29.97、4K23.976/60与3840宽存档、原生播放控制通过；解码回调不等于显示器最终呈现率。
- 独立成品机器：目标PATH仅System32，未安装项目开发依赖；冻结程序原生侧栏、系统英文OCR、包内Node桥接通过，实际解码720p H264共229帧、3783ms、两次不同像素取样。托管系统预装Python/Node，报告明确不称物理空白Windows。
- 分包：桌面包无QtWebEngine/Chromium、插件构建、模型权重或离线推理运行时。浏览器插件独立成包，无桌面EXE/DLL或浏览器内核。
- 本机真实模型：原生图片工具数学/无图/换Excel三组对照通过；两段真实B站原媒体的采集→OCR→概括→独立记忆→问答通过，另对三张真实画面完成知识/纯讲者分类。没有将OCR字幕或手写答案冒充图像像素；OCR误识仍须保留不确定性。

详细范围、检查包大小和当前限制见[原生分包说明](native-desktop.md)。这些基线结果不能替代后续版本对应源码的云端验收。

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


## 0.4.0 独立浏览器插件

当前范围是独立插件，原生桌面单独验收，不随本次插件发布。用户要求移除 BETA 标识，版本改为 0.4.0；这不表示此前列出的未实现能力已经完成。

验收命令：`npm ci`、`npm run compile`、`npm test`、`npm run build`、`python scripts/package-extension.py dist/Vidence-Browser-Extension.zip`、`python scripts/extension-package-check.py dist/Vidence-Browser-Extension.zip`、`node scripts/bridge-check.mjs`。

最终ZIP在新临时目录解压，并直接从那个目录加载到隔离浏览器，检查包完整性、禁止文件、原始许可、字幕记录与检索、关闭后不自弹的页面侧栏、API目录与用户选定模型的实际流式探测、栏内模型切换持久化、三语言更新/反馈与设置。API为自建受控服务，不是新增真实模型验收。Windows安装引导在系统PowerShell中以隔离LOCALAPPDATA和禁止实际打开浏览器的桩验证安装/重复更新，不触碰用户插件。

云端使用无项目依赖缓存的Linux和Windows托管机器，从源码安装开发依赖，再检测成品。插件运行只需要已有的Chrome/Edge；云端开发测试需要Node/Python不能解释为用户运行也需要它们。macOS、所有真实网站账号与物理空白机器不在本轮实测范围。


## 0.4.1 安装引导与纯插件包

新增命令：`python scripts/build-extension-installer.py dist/Vidence-Browser-Extension.zip dist/Vidence-Extension-Setup-Windows.exe`、`python scripts/extension-exe-check.py dist/Vidence-Extension-Setup-Windows.exe`。纯ZIP根目录为manifest.json，拒绝EXE/CMD/PS1/BAT及模型文件。

EXE在新Windows runner构建，输入是Linux已验收的同一个ZIP；搬到带空格的临时目录，将PATH设为System32后运行成品自检。自检使用临时AppData检查首次安装、重复安装、相邻学习数据标记保留、过期JS删除、路径穿越拒绝及内嵌SHA；不访问用户配置，也不打开浏览器。界面截图为离屏窗口渲染，不能当成真实账号安装或物理空白Windows验收。Windows系统自带.NET Framework仍是依赖，不随包分发。


0.4.1两次云端43168897895、43169542831在Windows Edge发现内层关闭操作未完成，发布均自动跳过；Linux通过。第二轮诊断显示父页面未收到任何关闭事件（trace为空），接收端兼容null source的修补未解决，已删除该过渡guard及对应8项测试。最终改为UI runtime.sendMessage → 后台验证tabId → tabs.sendMessage → 内容脚本closeDock，删除原postMessage关闭/弹出接收器，用户页面不能通过该旧通道控制关闭。

原145项单元检查保持通过；真实浏览器E2E继续点击内层×，额外核对后台收到目标视频tabId、拒绝无效目标、关闭不停止记录、不随刷新自动弹回。iframe URL中的tabId用于首屏状态尚未加载时的关闭请求；没有退回其他活动标签页。真实Edge由下述新云端流水线再次验收，没有用本机或单元测试替代。


### 0.4.1 最终验收与公开下载

[流水线43170402148](https://github.com/lby749/Vidence/actions/runs/43170402148)基于1ea095b891e337a8ae9976ab7562c834ba523b64，Linux Chromium、Windows Edge、另一台Windows安装器构建/搬移验收及release共4个任务全部success。两平台完整插件检查均实际点击内层×并观察正确目标tabId；原145项单元测试保持通过。

[v0.4.1公开发布页](https://github.com/lby749/Vidence/releases/tag/v0.4.1)为正式Latest，非草稿/非预发布。匿名完整下载两包、SHA资产与GitHub上传digest逐一一致：

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| Vidence-Browser-Extension.zip | 25,589,328 | 0678941294b9e0c67df775ce3694d4a7542efed263be08015f31db3b8accba99 |
| Vidence-Extension-Setup-Windows.exe | 25,699,328 | 55ea13547b0f1702fdedb90f455a9ad487cd4e4e5172171b0ff0836d2258e120 |

公开EXE在本机再次搬移运行，PATH仅System32，自检全部通过；输出的内嵌payload SHA等于公开ZIP。ZIP CRC/根manifest/无EXE与命令脚本/无模型与浏览器内核检查通过。实际公开目录输入更新解析器，0.4.0可获得0.4.1提示，0.4.1不误报升级。EXE Authenticode状态NotSigned，用户安装说明已如实提示。

这些结果仍不是物理空白Windows、用户真实账号下自动安装、macOS实机或新增真实模型验收。浏览器首次加载确认仍由用户操作。
