<p align="center"><img src="public/brand/icon-128.png" width="96" alt="视频记忆助手"/></p>

# 视频记忆助手 · BETA 测试版

**0.1.0-beta.1 · MIT**

把看过的视频，变成可以复习、检索和提问的学习记忆。

Windows 独立应用 + Chrome/Edge 浏览器扩展。支持本地 MP4、网页视频与网课窗口；每个视频分别保存画面、聊天和长期记忆。界面提供简体中文、繁体中文和英文，回答语言与风格单独设置。

<p align="center"><img src="assets/brand/project-cover.png" width="360" alt="项目配图：连接知识的星空"/></p>

## 能做什么

- 记录可读字幕或本地识别的画面文字，先概括，再用于回答。
- 自动发现画面变化，保存公式、图解、板书和操作步骤的候选图。
- 允许后，用当前视觉助手筛选知识画面：过滤纯讲者、开场和片尾；不确定的图单独待确认，原图保留，可恢复。
- 真正读取原图回答图形、公式和表格问题，附带时间引用，点击引用可打开原图。
- 每个视频拥有独立的聊天和长期记忆；支持多选批量整理、编辑、锁定、版本恢复和来源追溯。
- 连接已有 OpenCode Go/DeepSeek Harness，或填入自己的 API Key 自动获取并选择模型。聊天、整理和视觉角色可使用已有配置。
- 本地关键词查找、可选语义查找和精排；离线资源按“无／低／中／高占用”选择后下载，发行包不包含模型权重。
- 本地导入导出，导出不携带 API Key、连接令牌或账号。
- 应用新版本自动提醒，每天检查一次；可查看说明、前往发布页、稍后提醒或关闭自动检查。

## 普通用户怎么用

解压完整 Windows x64 发行包，双击“一键启动.exe”。不需要 Python、Node、npm 或开发环境。请保留整个文件夹。

BETA下载及每版说明放在[项目发布页](https://github.com/lby749/lby/releases)。只有云端源码检查、Windows构建和独立成品运行检查通过后，工作流才会创建新版本及SHA-256校验文件；已发布版本不覆盖，后续更新须提升package.json版本。

1. 打开本地视频，或选择网课网址/窗口；学习栏可展开和收起。
2. 开始记录，结束后到视频库继续复习和提问。
3. 在“设置 → 学习偏好”允许发送截图后，可勾选“允许读取画面”进行图片问答。
4. 开启“自动筛选知识画面”可在记录结束后筛选；已有视频可到“原文与节点 → 知识画面”手动筛选。
5. 开启离线功能时按需要下载资源，无需理解底层模型名称。

浏览器安装入口也在一键启动器里。它会准备扩展目录、复制路径并打开管理页面；首次仍需在浏览器中确认加载。缺少网页播放组件时使用随包的微软安装程序联网准备。

## 已验证的范围

- B站数学、地理/天文、Excel 原媒体的完整候选选帧与真实模型筛选。
- OpenCode Go 的 DeepSeek V4.1 Flash 真图片问答：有图读出公式；无图不猜测；换图后答案跟随实际图片。
- 图片引用预览、讲者/片尾过滤、待确认、人工恢复以及侧栏图片选项。
- TypeScript、单元检查、Python 检查及本机可搬移打包检查。

这些检查不等于所有平台账号、硬件和播放器场景均已验收。图片分类可能误判，模型抄读也可能有错；可以打开原图核对。完整功能状态与重复入口审查见 [功能审查](docs/feature-audit.md)。播放测试见 [帧率与清晰度](docs/playback.md)。详见 [知识画面](docs/keyframes.md) 和 [验收说明](docs/verification.md)。

BETA版本会持续修复和验证，不能把测试范围外的能力当作正式版承诺。

Android、TTS、听视频 ASR 尚未实现；iPhone 暂缓。Apple/AMD 实机及完整跨平台发行仍待验证。

## 开发

```sh
npm ci
npm run compile
npm test
npm run build
```

在 Chrome/Edge 扩展管理页加载 `.output/chrome-mv3`。Windows 开发环境：

```sh
python -m pip install -r requirements-dev.txt
python desktop/app.py
python -m unittest discover -s desktop -p "test_*.py"
```

项目结构、原生运行时准备和打包见 [开发入口](docs/architecture.md)。自动化 Agent 开始工作前阅读 [AGENTS.md](AGENTS.md)。

每次推送main会运行[云端验收工作流](.github/workflows/beta-validation.yml)，重新检出并安装源码依赖，另用独立Windows任务检查发行包。范围与“没有开发环境”的具体含义见[云端验收](docs/cloud-validation.md)，结果以实际运行记录为准。

## 隐私与许可证

学习数据默认在本机保存。读取云端模型需要用户自己的连接和授权；截图保存与图片上传是独立操作。不要把本地数据库、浏览器会话、测试视频或凭据提交进仓库。

项目代码使用 [MIT](LICENSE)。第三方依赖与随包运行时声明见 [依赖说明](docs/licenses.md)。品牌图标由项目所有者提供。
