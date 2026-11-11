"""打包可直接启动的 Windows 应用；只复制明确列出的代码和运行时。"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import pefile
from PySide6.QtCore import QLibraryInfo

root = Path(__file__).resolve().parents[1]
destination = root / sys.argv[1] if len(sys.argv) > 1 else root / 'dist/desktop-player'
assert root in destination.resolve().parents
assert not destination.exists(), '输出目录已存在；请指定一个新的 dist 子目录，避免覆盖运行中的版本'
output = destination / '视频记忆助手'
assert root in output.resolve().parents
assets = root / '.output/chrome-mv3'
assert (assets / 'desktop.html').exists(), '请先运行 npm run build'
assert not any(file.suffix.lower() in ('.onnx', '.tar', '.gguf', '.safetensors') for file in assets.rglob('*')), '发布目录不得包含模型权重'
node = Path(shutil.which('node') or '')
assert node.is_file(), '没有找到 Node 运行时'
assert (root / 'desktop/runtime/llama/cpu').is_dir(), '请先运行 python scripts/prepare-native-runtime.py'
command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--windowed', '--name', '视频记忆助手', '--icon', str(root / 'public/brand/app.ico'), '--distpath', str(destination), '--workpath', str(root / '.desktop-build/pyinstaller'), '--specpath', str(root / 'desktop'), '--add-data', f'{assets}{os.pathsep}.output/chrome-mv3', '--add-binary', f'{node}{os.pathsep}runtime', '--add-data', f'{root / "desktop/runtime/llama"}{os.pathsep}desktop/runtime/llama', '--add-data', f'{root / "src/models/desktop-embedding.json"}{os.pathsep}src/models']
# QWebView 是 Qt 6.11 新增 Python 绑定，旧 PyInstaller 没有专用 hook。
plugin = Path(QLibraryInfo.path(QLibraryInfo.LibraryPath.PluginsPath)) / 'webview'
for file in plugin.glob('*webview2*' if os.name == 'nt' else '*darwin*'):
    command += ['--add-binary', f'{file}{os.pathsep}PySide6/plugins/webview']
for file in ['local-agent-bridge.mjs', 'memory-relay.mjs', 'memory-mcp.mjs']:
    command += ['--add-data', f'{root / "scripts" / file}{os.pathsep}scripts']
command += ['--add-data', f'{root / "node_modules/js-yaml"}{os.pathsep}node_modules/js-yaml']
for license_file in [root / 'LICENSE', root / 'docs/licenses.md', node.parent / 'LICENSE']:
    if license_file.is_file():
        command += ['--add-data', f'{license_file}{os.pathsep}notices/{license_file.parent.name}']
command += [str(root / 'desktop/app.py')]
subprocess.run(command, cwd=root, check=True)
# 此 Qt 构建链接 Windows 的无版本 ICU 接口。PyInstaller 可能从 PATH
# 中的 Poppler 错收同名、带版本后缀的 ICU DLL，导致 QtCore 无法导入。
icu = output / '_internal/icuuc.dll'
if icu.exists():
    qt = pefile.PE(str(output / '_internal/PySide6/Qt6Core.dll'))
    required = {item.name for entry in qt.DIRECTORY_ENTRY_IMPORT if entry.dll.lower() == b'icuuc.dll' for item in entry.imports if item.name}
    qt.close()
    library = pefile.PE(str(icu))
    bundled = {item.name for item in library.DIRECTORY_ENTRY_EXPORT.symbols if item.name}
    library.close()
    if required and not required.issubset(bundled):
        library = pefile.PE(str(Path(os.environ['SystemRoot']) / 'System32/icuuc.dll'))
        system = {item.name for item in library.DIRECTORY_ENTRY_EXPORT.symbols if item.name}
        library.close()
        assert required.issubset(system), '系统 ICU 与 Qt 不兼容，不能发布'
        icu.unlink()
        unused_data = output / '_internal/icudt78.dll'
        if unused_data.exists(): unused_data.unlink()
assert not any(file.suffix.lower() in ('.onnx', '.tar', '.gguf', '.safetensors') for file in output.rglob('*'))
subprocess.run([sys.executable, str(root / 'scripts/build-launcher.py'), str(output)], cwd=root, check=True)
report = {'output': str(output), 'bytes': sum(file.stat().st_size for file in output.rglob('*') if file.is_file()), 'bundledModelWeights': 0}
(root / 'artifacts/desktop-package.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
