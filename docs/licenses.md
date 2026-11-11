# 第三方组件与模型许可证

本项目源码以 MIT 发布。以下为运行时与构建依赖的实际版本与许可证（读取自安装包 `package.json`）。

## 运行时依赖

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| WXT | 0.21.5 | MIT | 扩展工程与构建 |
| React / React DOM | 19.3.1 | MIT | 侧边栏、知识库界面 |
| Dexie.js | 4.4.7 | Apache-2.0 | IndexedDB 封装 |
| Orama | 3.1.18 | Apache-2.0 | 本地全文/向量检索 |
| @orama/tokenizers | 3.1.18 | Apache-2.0 | 中文（Mandarin）分词 |
| @paddleocr/paddleocr-js | 0.4.2 | Apache-2.0 | 浏览器 OCR |
| @huggingface/transformers | 4.3.2 | Apache-2.0 | 浏览器模型推理 |
| onnxruntime-web（传递依赖） | 1.31.x | MIT | ONNX 推理后端 |
| @techstark/opencv-js（传递依赖） | 4.10 | Apache-2.0 | PaddleOCR 图像预处理 |

## 模型与权重

| 模型 | 来源 | 许可证/说明 |
| --- | --- | --- |
| PP-OCRv5 mobile det/rec | PaddleOCR 官方模型库（BCE 对象存储） | Apache-2.0；由用户按功能下载，不进入发布包 |
| bge-small-zh-v1.5（Xenova ONNX 导出） | Hugging Face | 模型卡标注 MIT；量化 q8，512 维，CLS pooling + L2 归一化 |
| bge-reranker-base（Xenova ONNX 导出） | Hugging Face | MIT；本地 int8 神经重排 |

本机开发测试模型由 scripts/fetch-models.mjs 准备，保留在 public，但构建排除所有权重。用户按功能下载，model-manifest.json 记录文件大小与 SHA-256；嵌入、重排的下载地址另固定到 model-info.ts 记录的上游提交。

## 独立应用运行时

独立应用使用已安装 PySide6 6.11.2 / Qt 组件（包元数据：LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only）、Python、Node.js 及 js-yaml。打包保留动态库与组件来源说明，构建脚本在 scripts/build-desktop.py；第三方程序运行时不等于模型权重。源码修改可在 desktop/app.py 与 src/entrypoints/desktop 中查看和重新构建。

构建会用scripts/prepare-notices.py将已安装npm依赖、Python和PySide元数据中的原始声明保留到_internal/notices；Node声明按实际随包版本获取，另保留Qt的LGPL/GPL原文。保留这些依赖的原许可证，不将它们重新声明为项目MIT代码。

## 参考项目（未复制代码）

以下项目仅用于参考设计思路，代码未直接包含在本仓库：

- GoogleChrome/chrome-extensions-samples（Apache-2.0）：side panel、消息通信参考。
- video-context-mcp：时间线/帧读取工具接口参考；外部 MCP 项目，非实时采集 SDK。
- VideoRAG（HKUDS）：多模态证据组织参考；未搬入离线处理栈。
- VideoSubFinder（GPL）：硬字幕定位与去重思路参考；**未复制其代码**，避免 GPL 传染。
- PySceneDetect（BSD-3-Clause）：镜头检测与自适应阈值思路参考。
- Tesseract.js / Gutenye OCR / MiniSearch：备用方案，未装入默认构建。

## 许可证合规提示

- 若将来引入 VideoSubFinder 等 GPL 组件，需要重新评估整个扩展的分发方式。
- PaddleOCR 的模型与代码分别适用其各自许可证；再分发模型时需附上对应许可证与来源。
- 使用用户提供的 API Key 调用第三方模型时，需遵守相应提供商的服务条款；本项目不代用户获取或转售额度。


## 新增原生检索与界面本地化

- llama.cpp b11597：MIT；CPU/Vulkan/Metal运行时来源与摘要固定于 src/models/native-runtime.json。运行时目录包含 LICENSE-llama.cpp。模型权重不分发，下载的EmbeddingGemma遵循其模型许可。
- QtWebView使用Windows系统WebView2 / macOS WKWebView；最新PySide6的QWebView代替已删除的pywebview工作进程，未把pywebview及其额外依赖打包。
- 繁体字典开发时由 [OpenCC Python](https://github.com/yichen0831/opencc-python) 0.1.7的s2twp转换生成。只提交生成的界面JSON，运行与打包不依赖该Python库；生成脚本 scripts/generate-traditional-ui.py，词组已作界面检查。
- Windows启动器附微软签名的WebView2 Evergreen Bootstrapper，缺少组件时联网安装。来源为[微软官方分发指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)及官方链接 https://go.microsoft.com/fwlink/p/?LinkId=2124703；适用微软分发条款，不标为本项目MIT代码。当前固定SHA-256在desktop/launcher.py，构建时已核验Microsoft Corporation的有效Authenticode签名。
- 未上架商店时，浏览器首次安装需用户确认。流程依据[Edge侧载指南](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)及[Chrome安装分发文档](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)，不使用企业强制安装策略。固定插件目录ID计算参考[Chromium id_util.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc)。
