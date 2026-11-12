# 开发入口

Vidence 帮助用户边看视频边提问、整理学习笔记，并在以后查找和复习。本页供继续开发的人了解这些功能由哪些部分负责，以及如何运行和打包项目；日常使用先看[项目介绍](../README.md)。

浏览器插件由 WXT / React 构建，在用户已有的 Chrome / Edge 内运行，以 Dexie / IndexedDB 保存资料。桌面界面和右侧学习栏由 PySide6 Qt Widgets 实现，以标准库 SQLite 保存资料，视频由 Qt Multimedia 直接解码显示。两者独立构建和发包，不再以网页承载桌面界面。桌面不捆绑 QtWebEngine、Chromium、浏览器插件构建或模型权重。

| 位置 | 职责 |
| --- | --- |
| src/pipeline/visual.ts | 低分辨率画面变化、稳定等待、去重和截图额度 |
| src/background/visual-service.ts | 真实画面落库、实际媒体时间、停止/代次检查 |
| src/agent/knowledge-frames.ts | 按批看图筛选、具体知识描述、待确认、格式修复 |
| src/agent/tools.ts | 限定视频和节点的检索、时间线、图片读取和请求内引用 |
| src/agent/local-memory-client.ts | 向 DSH/OpenCode Go 的临时 MCP 通道传递文字及真实图片 |
| scripts/local-agent-bridge.mjs | 本机鉴权桥接，启动用户配置的智能体，保留真实用量 |
| src/agent/question-agent.ts | 用户 API 问答及有限轮工具调用 |
| src/agent/local-agent.ts | 本地智能体问答，核验引用，记录实际图片读取数 |
| src/agent/long-term-memory.ts | 按视频概括、生成、编辑和召回长期记忆 |
| src/shared/app-updates.ts | 匿名版本检查、BETA/正式版本比较、每日缓存与暂缓 |
| desktop/native_ui.py | 原生来源面板、聊天、笔记、记忆、资料库与设置 |
| desktop/native_recording.py | 主动记录时低频采样、原图保存及系统OCR |
| desktop/native_store.py | SQLite持久化、视频隔离、记忆版本和导入导出 |
| desktop/native_agent.py | 摘要后问答、限定资料工具及真实原图读取 |
| src/entrypoints/library | 视频库、知识画面、聊天、设置和下载 |
| desktop/app.py / native_media.py | 原生桌面入口、播放、窗口采集和挂靠 |
| desktop/launcher.py | 原生桌面启动及独立插件下载入口 |
| scripts/package-extension.py | 独立插件包与系统自带PowerShell安装引导 |

## 图片筛选与问答

变化检测只产生候选图，不代表语义重点。用户允许后，当前视觉助手读取原图，输出具体知识标题、可见摘要和逐字文字。明确非知识画面隐藏；判断不足单独待确认；原图保留，允许人工恢复。

模型筛选摘要是派生数据，不能替代原图作为事实引用。问答通过 get_timeline/search_library 发现本视频图片，再用 get_frame 读取实际像素。图片工具创建请求内的画面证据，回答引用保留图片 ID 和真实时间，界面可以打开引用原图。

原生问答的初始资料另附 `imageAccess`：本次是否获准读图，以及从 NativeTools 范围快照中取出的最多六个原图 ID 和时间，不附图片像素。摘要写“未提供图像”不能证明没有原图；模型仍须调用 get_frame 核对。禁图时目录为空，全局授权、视频、笔记时间、ID 白名单及图片预算仍由工具检查。

每批最多六张。失败、取消、ID 不匹配、视频被删除时不提交本批结论。格式错误仅做一次文字修复，不重复上传图片；再次失败保留已完成结果。用量来自模型返回，不将未知用量记成零消耗。

## 构建与本地开发

前端要求支持 Vite 8 的 Node 版本，本项目本机使用 Node 24。执行 npm ci、npm run build 后，可以在扩展管理页加载 .output/chrome-mv3。Windows 开发环境安装 requirements-dev.txt 后运行 python desktop/app.py；桌面主界面不再需要先运行 npm run build。

桌面用 python scripts/build-desktop.py dist/新的输出目录 构建；不依赖 npm run build 的扩展产物，也不打包离线推理运行时。模型与 CPU/Vulkan/Metal 计算组件由用户按档位选择下载，先校验固定大小和 SHA-256，再允许加载。插件先 npm run build，再 python scripts/package-extension.py dist/新的插件包.zip。脚本拒绝覆盖已有输出。

普通用户只需解压完整发行包并运行一键启动.exe。开发依赖和运行用户依赖是两回事。

版本与发布也分开：浏览器插件使用 package.json / wxt.config.ts 及 v 标签；桌面使用 desktop/app_version.py 及 desktop-v 标签。desktop-release.yml 在 Windows 构建并由另一台 runner 检查冻结成品后，只发布桌面 ZIP 与校验文件。双方更新解析器各自过滤，桌面发行不改变浏览器插件的当前版本。

应用更新读取GitHub Releases公开版本元数据，每天一次；不发送课程、图片、账号或API Key。设置可手动检查和关闭自动提醒。草稿、旧版和其他仓库地址不推荐，更新说明按纯文本展示；失败不显示“已是最新版”。私有发布目录尚未公开时，检查会明确不可用。

Vidence 更名保留既有数据目录 VideoMemoryAssistant、数据库名及本机服务地址，避免拆出一份空白学习库。更新缓存同时保存仓库名；更换发布源时丢弃旧结果，保留自动提醒开关。早期 BETA.1/BETA.2 包使用旧地址且拒绝重定向，需要手动安装一次 BETA.3 或更新版本。

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/Vidence)，谢谢！

## 原生版边界

原生学习栏的聊天、记忆、原图读取、检索均以 videoId 隔离；笔记范围还核对起止时间。系统OCR不含置信度保证，低分辨率、小字和公式可能误识，摘要须保留不确定性；重要画面用经授权的原图问答核对。窗口采集的时间标为“记录时间”，不能冒充课程播放器进度。

应用内课程网页仅借用系统已有 WebView2；它不是桌面界面的渲染层。不随包分发 WebView2 内核或自动安装程序，缺少该系统组件时仍能使用本地视频与外部课程窗口。原生版暂未迁移 Notion 同步和 AI 网页渠道；浏览器插件保留对应原有功能。旧 IndexedDB 不删除，原生 SQLite 导入目前以旧版导出资料为入口，尚未完成所有旧聊天的自动迁移。

## 独立插件安装分发

0.4.1提供原生Windows安装引导EXE与纯插件ZIP。ZIP根目录即扩展manifest.json，只含扩展资源、说明及原始许可。EXE使用系统.NET Framework/WinForms，内嵌相同ZIP，校验SHA后暂存并替换%LOCALAPPDATA%/VideoMemoryAssistant/browser-extension代码目录；不读取浏览器资料或写入策略。浏览器首次确认仍由用户完成。构建scripts/build-extension-installer.py，成品搬移验收scripts/extension-exe-check.py；原生桌面播放器不包含在这个EXE中。
