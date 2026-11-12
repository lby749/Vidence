<p align="center"><img src="public/brand/icon-128.png" width="96" alt="Vidence"/></p>

# Vidence

**边看视频边提问，把学过的内容留下来。**

Vidence 是一款 AI 视频学习助手。看网课、教程或知识视频时，它可以帮你记录重点、整理笔记、解答疑问；看完以后，还能找到之前学过的内容，回到相关片段复习。

## 下载与使用

**[打开下载与版本页面](https://github.com/lby749/Vidence/releases)**

原生桌面与浏览器插件分别下载。桌面版使用原生播放器和右侧学习栏，插件配合已有 Chrome / Microsoft Edge 使用。

| 下载 | 怎么使用 |
| --- | --- |
| **[Windows 原生桌面版 0.4.2](https://github.com/lby749/Vidence/releases/download/desktop-v0.4.2/Vidence-Desktop-Windows-x64.zip)** | 完整解压，双击“一键启动.exe”；播放本地视频，或把学习栏靠在已经打开的课程窗口旁 |
| **[Windows 安装引导 EXE](https://github.com/lby749/Vidence/releases/download/v0.4.1/Vidence-Extension-Setup-Windows.exe)**（推荐 Windows 10 / 11） | 直接双击，选择浏览器，点击安装并打开浏览器；无需解压、CMD 或开发工具 |
| **[纯插件 ZIP](https://github.com/lby749/Vidence/releases/download/v0.4.1/Vidence-Browser-Extension.zip)** | 完整解压，在扩展管理页加载包含 `manifest.json` 的文件夹；适合手动安装和 macOS / Linux |

首次使用仍需在浏览器开启开发者模式，确认“加载已解压的扩展”。EXE 会提供文件夹路径并打开安装页，不能代替浏览器内的确认。详见[插件安装说明](docs/browser-extension.md)。

桌面版与插件**都不附带浏览器内核和模型权重**，无需安装 Python / Node.js。桌面主界面、播放器和学习栏使用 Qt 原生控件；插件直接使用已有浏览器。纯插件 ZIP 不含 EXE、CMD 或 PowerShell。可选离线模型由用户按需要选择下载。详见[桌面版使用说明](docs/native-desktop.md)。

<p align="center"><img src="assets/brand/project-cover.png" width="360" alt="项目配图：连接知识的星空"/></p>

## 它能帮你做什么

- **不懂就问**：遇到没听懂的概念、公式或操作步骤，直接在视频旁边提问。
- **整理学习重点**：记录视频中的文字和重要画面，整理成摘要与笔记，方便课后回顾。
- **结合画面讲解**：允许读取截图后，可以围绕图表、板书和公式提问，并打开原图核对。
- **找回学过的内容**：通过关键词或问题查找笔记、截图和对应时间，减少来回拖动进度条。
- **积累学习记忆**：选择看过的视频分别整理、保存，之后继续复习和追问；不同视频的笔记与聊天分开管理。

跟着网课复习、学习软件操作，或观看知识科普视频时，都可以把 Vidence 放在旁边使用。

## 开始使用

1. 选择 EXE 引导或纯插件 ZIP 安装，打开想学习的视频网页。点击视频旁的 Vidence 按钮，再打开右侧学习栏。
2. 在“配置 API”粘贴自己的 API Key，获取可用模型并测试连接；也可以自行选择模型。
3. 开始记录、提问，结束后到视频库整理笔记和长期记忆。不同视频分别保存。
4. 学习栏可通过右上角 × 关闭；再次点击页面上的 Vidence 按钮即可打开。

浏览器会要求你亲自确认加载扩展，安装引导不会绕过这一步。已有插件用户请保留原浏览器与安装目录，更新文件后在扩展管理页点击“重新加载”；不要卸载插件后重装，以免删除浏览器中的学习资料。

API 问答不依赖桌面程序。本机 OpenCode Go / DSH 等智能体属于可选连接，需要另行运行对应工具与桥接服务，本次插件包不附带它们。受保护视频、不可读取字幕或禁止截图的页面可能只提供有限功能；不会解锁平台限制。

## 反馈与建议

当前桌面版为 **0.4.2**，浏览器插件为 **0.4.1**，仍在持续完善。如果遇到问题，或有什么改进建议，欢迎通过[问题反馈与建议](https://github.com/lby749/Vidence/issues/new/choose)提出，非常感谢！

应用内也可以在“设置 → 应用更新”点击“反馈问题或建议”。

## 更多说明

- [功能与支持范围](docs/feature-audit.md)
- [AI 服务设置](docs/setup-models.md)
- [开发说明](docs/architecture.md)与 [Agent 工作说明](AGENTS.md)
- [测试与验证记录](docs/verification.md)

学习数据默认保存在本机。使用云端 AI 时，会按你的设置发送回答所需的内容；截图本地保存与允许上传是两回事。

项目代码采用 [MIT 许可证](LICENSE)，第三方组件保留[各自的声明](docs/licenses.md)。

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/Vidence)，谢谢！
