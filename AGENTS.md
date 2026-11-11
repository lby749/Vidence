# Agent 工作说明

## 开始修改前

- 先阅读 README.md、docs/architecture.md、docs/keyframes.md，检查 git status。保护已有工作和用户数据。
- 先追踪真实调用链，说明关键假设；有歧义时说明不同解释。优先参考现有开源实现，尽量复用本项目和标准库。
- 只修改任务涉及的代码，不重排无关文件、不删除原项目、不引入一次性抽象。删除本次修改造成的孤儿代码。
- 持续运行可验证的检查；不要只提交计划或宣称接口存在即功能通过。

## 项目边界

- 每个视频的字幕、画面、聊天、长期记忆、检索范围必须以 videoId 隔离。选中节点还要核对时间范围。
- 原始图片与 AI 筛选结论分开保存。纯讲者、片头片尾默认不进入知识画面；不确定结果单独待确认，用户可恢复。讲师与板书同框不能简单按人脸删除。
- 截图本地保存不等于允许上传。遵守全局设置、本次读图授权、请求内 ID 白名单及图片预算；不得把一次授权永久写到原图上。
- 图片问答须真正传递原图，并提供可核验的图片 ID/时间引用。禁止用手写“标准答案”、字幕或文件名冒充看图成功。
- 新视觉模型或协议必须做有图、无图、换图对照。模型目录中的图片能力声明只是线索，真实请求才是证据。
- 字幕先概括，再进问答上下文；原文和图片按需读取，模型生成的图片摘要只是检索线索。
- 不打包模型权重、浏览器配置、登录态、测试课程、数据库、令牌或 API Key。禁止在日志、导出、Git 提交中输出凭据。
- 测试完成后暂停/关闭自己的视频和测试浏览器，不操作用户其他窗口，不中断用户正在记录的课程。

## 验证命令

```sh
npm ci
npm run compile
npm test
npm run build
python -m unittest discover -s desktop -p "test_*.py"
node scripts/sidebar-layout-check.mjs
node scripts/update-ui-check.mjs
```

- 真实模型测试为 `scripts/knowledge-qa-check.mjs` 和 `scripts/knowledge-frame-review.mjs`，需要用户配置的 OpenCode Go/DSH。它们消耗模型额度，不能在普通单元检查中自动运行。
- 本机媒体验收报告保存在被忽略的 artifacts/。没有原媒体时不得用模拟截图冒充真实视频验收。
- 真实窗口、无界面 UI、测试桥接、单元测试、发行包搬移检查属于不同证据层，必须区分。
- 图片来自 assets/brand/logo-source.png；用 `python scripts/prepare-brand.py` 生成 PNG/ICO。应用、启动器、扩展和品牌标识统一，操作按钮保留语义。
- 发布前核对源码、构建文件和随包脚本一致，并验证没有系统 Python/Node 的启动路径。不得把缺少 WebView2 的模拟分支称为新装 Windows 实测。
- 主分支云端源码、成品运行检查通过后才创建 BETA Release；已有发布不覆盖。发布下一版应提升 package.json 版本及 wxt.config.ts 的显示版本，自动提醒只读取公开版本元数据，不发送学习数据或凭据。

## 尚未完成

Android、TTS、听视频 ASR 尚未实现；iPhone 暂缓。Apple/AMD 实机、所有平台账号、最新全部原生全屏场景仍须各自验证。不要把入口、自动降级代码或 headless 检查写成实机通过。

## 许可证

项目使用 MIT。保留依赖的第三方声明，不将它们错误地重新声明为本项目原创代码。

感谢您的支持，如果有帮助的话，请点一个 [STAR](https://github.com/lby749/Vidence)，谢谢！
