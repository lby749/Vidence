"""原生桌面启动器；不附带插件、浏览器内核或网页组件安装程序。"""
from pathlib import Path
import json
import shutil
import subprocess
import sys
root=Path(__file__).resolve().parents[1]
output=(root/sys.argv[1]).resolve() if len(sys.argv)>1 else root/'dist/desktop-player/Vidence'
assert root in output.parents and (output/'Vidence.exe').is_file()
work=root/'.desktop-build/launcher-native'; work.mkdir(parents=True,exist_ok=True)
spec=work/'launcher.spec'
spec.write_text(f'''a = Analysis([{str(root/'desktop/launcher.py')!r}], pathex=[{str(root/'desktop')!r}], binaries=[], datas=[], hiddenimports=[], hookspath=[], hooksconfig={{}}, runtime_hooks=[], excludes=['PySide6.QtWebEngineCore','PySide6.QtWebEngineWidgets','PySide6.QtWebEngineQuick','PySide6.QtQuick','PySide6.QtQml'], noarchive=False, optimize=0)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='一键启动', debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=False, icon={str(root/'public/brand/app.ico')!r})
''',encoding='utf8')
subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--distpath',str(work/'bin'),'--workpath',str(work/'build'),str(spec)],cwd=root,check=True)
shutil.copy2(work/'build/launcher/一键启动.exe',output/'一键启动.exe')
for source,name in [(root/'LICENSE','LICENSE.txt'),(root/'docs/licenses.md','第三方声明.md'),(root/'public/brand/app.ico','应用图标.ico')]:shutil.copy2(source,output/name)
(output/'启动Vidence.cmd').write_bytes('@echo off\r\nchcp 65001 >nul\r\nstart "" "%~dp0一键启动.exe" --open\r\n'.encode('utf8'))
(output/'使用说明.txt').write_text('''Vidence · 原生桌面 BETA 测试版

Vidence 帮你边看视频边提问、整理重点，并分别保存每个视频的学习记忆。

1. 完整解压后打开“一键启动.exe”，无需系统 Python、Node 或开发工具。
2. 打开本地视频，或选择已经打开的课程窗口。右侧学习栏可展开、收起。
3. 先连接自己的 AI 服务，再开始记录或提问。默认不发送截图，读图须单独授权。
4. 浏览器插件是独立产品，请到 https://github.com/lby749/Vidence/releases 下载插件包。
   插件直接使用已经安装的 Chrome / Edge，不需要安装桌面应用或额外浏览器内核。
5. 桌面主界面和侧栏是原生控件，不附带 Chromium / QtWebEngine。
   “应用内课程网页”使用系统已有 WebView2；系统没有时可在外部浏览器播放并挂靠侧栏。
6. 模型权重按需下载，发行包不含模型、课程、登录态或用户学习资料。
7. 旧版学习数据库保留在原位置。本版原生数据使用 SQLite；旧版导出文件可从视频库导入。

这是 BETA 测试版，还不够完善。建议和问题欢迎提交到项目 Issues，非常感谢！
感谢您的支持，如果有帮助的话，请点一个 STAR，谢谢！
''',encoding='utf8')
report={'output':str(output),'requiresSystemPython':False,'requiresSystemNode':False,'browserExtensionBundled':False,'browserKernelBundled':False,'desktopUi':'Qt Widgets'}
(root/'artifacts/launcher-package.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=True))
