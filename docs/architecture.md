# 开发入口

前端由 WXT 构建，React 界面在 Chrome/Edge MV3 扩展和 PySide6 Windows 应用中复用。Dexie/IndexedDB 保存视频、原始证据、图片、节点、聊天和长期记忆；不同运行入口拥有各自的本地库。

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
| src/entrypoints/desktop | 来源选择、原生播放器与右侧学习栏 |
| src/entrypoints/library | 视频库、知识画面、聊天、设置和下载 |
| desktop/app.py | Windows 本地播放、窗口采集、Qt/WebView 及本机服务 |
| desktop/launcher.py | 无需开发环境的启动和浏览器安装向导 |

## 图片筛选与问答

变化检测只产生候选图，不代表语义重点。用户允许后，当前视觉助手读取原图，输出具体知识标题、可见摘要和逐字文字。明确非知识画面隐藏；判断不足单独待确认；原图保留，允许人工恢复。

模型筛选摘要是派生数据，不能替代原图作为事实引用。问答通过 get_timeline/search_library 发现本视频图片，再用 get_frame 读取实际像素。图片工具创建请求内的画面证据，回答引用保留图片 ID 和真实时间，界面可以打开引用原图。

每批最多六张。失败、取消、ID 不匹配、视频被删除时不提交本批结论。格式错误仅做一次文字修复，不重复上传图片；再次失败保留已完成结果。用量来自模型返回，不将未知用量记成零消耗。

## 构建与本地开发

前端要求支持 Vite 8 的 Node 版本，本项目本机使用 Node 24。执行 npm ci、npm run build 后，可以在扩展管理页加载 .output/chrome-mv3。Windows 开发环境安装 requirements-dev.txt 后运行 python desktop/app.py。

打包前准备原生推理运行时：python scripts/prepare-native-runtime.py。然后使用 python scripts/build-desktop.py dist/新的输出目录；脚本拒绝覆盖已有输出。模型权重由最终用户在应用中按档位下载。

普通用户只需解压完整发行包并运行一键启动.exe。开发依赖和运行用户依赖是两回事。

应用更新读取GitHub Releases公开版本元数据，每天一次；不发送课程、图片、账号或API Key。设置可手动检查和关闭自动提醒。草稿、旧版和其他仓库地址不推荐，更新说明按纯文本展示；失败不显示“已是最新版”。私有发布目录尚未公开时，检查会明确不可用。

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/lby)，谢谢！
