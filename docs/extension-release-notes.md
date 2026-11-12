Vidence 是一款 AI 视频学习助手，帮你边看视频边提问、整理重点、保存每个视频的学习记忆，之后查找和复习。

## 选一种方式下载

| 文件 | 适合谁 |
| --- | --- |
| **[Windows 安装引导 EXE](https://github.com/lby749/Vidence/releases/download/v0.4.1/Vidence-Extension-Setup-Windows.exe)** | Windows 10 / 11 用户，直接双击，选择浏览器并按图形引导完成，无需解压或运行 CMD |
| **[纯插件 ZIP](https://github.com/lby749/Vidence/releases/download/v0.4.1/Vidence-Browser-Extension.zip)** | 想要单独插件文件、手动安装，或使用 macOS / Linux 的用户；解压后直接加载包含 manifest.json 的文件夹 |

两个文件包含同一套插件，选一个即可。其他 `.sha256` 文件用于校验下载，Source code 是开发源码。

**首次安装仍需在 Chrome / Edge 中开启开发者模式，点击“加载已解压的扩展”确认。** EXE 会准备文件、提供目录路径并打开安装页，不会替你修改浏览器配置来强装。[详细安装说明](https://github.com/lby749/Vidence/blob/main/docs/browser-extension.md)。

## 0.4.1 更新内容

- 新增独立 Windows 图形安装引导，不需要 CMD、PowerShell、Python 或 Node.js；使用 Windows 系统已有的 .NET Framework。
- 提供纯插件 ZIP，不含 EXE 或命令脚本，解压后就是可加载的插件目录。
- EXE 自带完整插件，无需额外下载 ZIP；校验内嵌文件完整性后安装到原有固定目录，支持重复更新，移除过期代码文件并保留相邻资料。
- 两种下载不含浏览器内核、原生桌面程序或模型权重。原生桌面版仍单独完善。
- 修复部分 Edge 环境把侧栏关闭消息隐藏发送窗口时，内部关闭按钮无效的问题；同时校验扩展来源与可信事件，拒绝网页伪造消息。
- 保留 0.4.0 的记录、检索、按视频分开的学习记忆、栏内助手与模型选择、API 配置、语言、更新及反馈功能。

已有用户不要先卸载插件。此前使用固定安装目录的用户运行 EXE 后在浏览器点“重新加载”；手动安装在其他目录的用户请用纯插件 ZIP 更新原来的 manifest.json 所在目录，以保留扩展身份与资料。建议先导出备份。

EXE 未附商业代码签名，Windows 可能提示未知发布者；可选择纯 ZIP 手动安装。受保护课程、跨域播放器和平台变化可能限制字幕或画面采集。

## 验证与反馈

发布前在 Linux / Windows 新托管机器检查 153 项单元测试、构建与最终 ZIP 解压后加载、字幕记录与检索、侧栏、受控 API 模型配置、设置和更新反馈。另在新的 Windows 机器用系统编译器构建 EXE，搬到新目录后将 PATH 限制为 System32，检查内嵌包、首次准备、重复更新、资料保留、旧文件清理和非法路径拒绝。安装器 UI 为离屏渲染检查，不等同于用户账号下的自动浏览器安装；没有声称新真实模型或所有账号平台通过。

当前项目仍有不完善的地方。如果遇到问题或有改进建议，欢迎到[反馈页面](https://github.com/lby749/Vidence/issues/new/choose)提出，非常感谢！

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/Vidence)，谢谢！
