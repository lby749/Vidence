"""给现有独立应用添加共用其运行时的一键启动器与安装入口。"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
output = (root / sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'dist/desktop-player/视频记忆助手'
assert root in output.parents and (output / '视频记忆助手.exe').is_file()
sys.path.insert(0, str(root / 'desktop'))
from launcher import BOOTSTRAP_SHA256
runtime = root / 'desktop/runtime/webview2/MicrosoftEdgeWebview2Setup.exe'
if not runtime.exists():
    runtime.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen('https://go.microsoft.com/fwlink/p/?LinkId=2124703', timeout=30) as response:
        data = response.read()
    assert hashlib.sha256(data).hexdigest() == BOOTSTRAP_SHA256, '微软安装程序版本已变化，需核验签名并更新固定摘要'
    runtime.write_bytes(data)
assert hashlib.sha256(runtime.read_bytes()).hexdigest() == BOOTSTRAP_SHA256, '网页播放安装程序摘要不匹配'
work = root / '.desktop-build/launcher'
work.mkdir(parents=True, exist_ok=True)
spec = work / 'launcher.spec'
spec.write_text(f'''a = Analysis([{str(root / 'desktop/launcher.py')!r}], pathex=[], binaries=[], datas=[], hiddenimports=[], hookspath=[], hooksconfig={{}}, runtime_hooks=[], excludes=[], noarchive=False, optimize=0)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='一键启动', debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=False, icon={str(root / 'public/brand/app.ico')!r})
''', encoding='utf-8')
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--distpath', str(work / 'bin'), '--workpath', str(work / 'build'), str(spec)], cwd=root, check=True)
shutil.copy2(work / 'build/launcher/一键启动.exe', output / '一键启动.exe')
destination = output / '_internal/desktop/runtime/webview2'
destination.mkdir(parents=True, exist_ok=True)
shutil.copy2(runtime, destination / runtime.name)
for source, name in [(root / 'LICENSE', 'LICENSE.txt'), (root / 'docs/licenses.md', '第三方声明.md'), (root / 'public/brand/app.ico', '应用图标.ico')]:
    shutil.copy2(source, output / name)
for name, arguments in [('启动视频记忆助手.cmd', '--open'), ('一键安装到浏览器.cmd', '--install-browser')]:
    (output / name).write_bytes(('@echo off\r\nchcp 65001 >nul\r\nstart "" "%~dp0一键启动.exe" ' + arguments + '\r\n').encode('utf-8'))
(output / '使用说明.txt').write_text('''视频记忆助手 · Windows 10/11 x64

1. 解压整个文件夹，双击「一键启动.exe」。无需安装 Python、Node 或开发工具。
2. 选择「打开学习空间」，即可打开本地视频或网课。重复启动会返回已打开的学习窗口。
   记录会保留文字和变化画面；到“视频库 → 原文与节点 → 画面记录”展开图片，点时间回看。
3. 首次缺少网页播放组件时，启动器会用微软安装程序联网准备；断网时可先用本地视频。
4. 浏览器插件：选择「安装浏览器插件」，选 Edge 或 Chrome，点准备并打开安装页。
   启动器会复制路径；在浏览器打开开发人员模式，加载解压缩的扩展并粘贴路径确认。
   插件文件保留在本机应用数据目录，移动发布包不影响这个安装路径；更新后点浏览器的重新加载。
5. 按需要下载离线功能。发布包没有模型权重、测试课程、用户密钥或账号。
6. AI 问答需连接你自己的 AI 服务。可直接用 API Key 一键获取并选择模型；已有的智能体可连接后使用。

请保留整个文件夹。只复制某一个 EXE 会缺少随附程序。尚未上架浏览器商店，首次安装必须在浏览器确认。
''', encoding='utf-8')
report = {'output': str(output), 'launcher': str(output / '一键启动.exe'), 'requiresSystemPython': False, 'requiresSystemNode': False, 'requiresNpm': False, 'extensionInstallation': 'browser-confirmation-required', 'webviewMissing': 'bundled-official-online-bootstrapper'}
(root / 'artifacts/launcher-package.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
