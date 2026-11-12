"""独立浏览器插件包：仅扩展资源与Windows安装引导，无浏览器内核或桌面运行时。"""
import json
import hashlib
from pathlib import Path
import sys
import zipfile

root=Path(__file__).resolve().parents[1]
source=root/'.output/chrome-mv3'; manifest=json.loads((source/'manifest.json').read_text(encoding='utf8'))
assert manifest.get('manifest_version')==3
output=(root/sys.argv[1]).resolve() if len(sys.argv)>1 else root/'dist/Vidence-Browser-Extension.zip'
assert root in output.parents and not output.exists(),'请选择新的输出文件，不覆盖已有发行包'
output.parent.mkdir(exist_ok=True,parents=True)
files=[file for file in source.rglob('*') if file.is_file()]
for file in files:
    assert not file.is_symlink()
    assert file.suffix.lower() not in ('.exe','.dll','.onnx','.gguf','.safetensors','.db','.sqlite','.pyc')
    assert file.name!='desktop.html' and 'webengine' not in file.name.lower()
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for file in files:archive.write(file,Path('Vidence-Extension/extension')/file.relative_to(source))
    archive.write(root/'scripts/install-extension.ps1','Vidence-Extension/安装插件.ps1')
    archive.writestr('Vidence-Extension/安装到浏览器.cmd','@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装插件.ps1"\r\npause\r\n'.encode('utf8'))
    archive.writestr('Vidence-Extension/使用说明.txt','''Vidence · 浏览器插件 BETA

Vidence 帮你在浏览器看视频时提问、整理重点、保存每个视频的学习记忆。

本包直接使用你已经安装的 Chrome / Edge，不附带浏览器内核，不要求安装桌面应用。
Windows：完整解压，双击“安装到浏览器.cmd”，选择浏览器，按安装页提示完成。
其他系统：打开扩展管理页，开启开发者模式，加载本包的 extension 文件夹。
浏览器要求用户亲自确认安装，脚本不能绕过这一步。

AI 问答可在设置中连接自己的 API Key 并获取模型目录，不依赖桌面应用。
使用本机 OpenCode Go / DSH 时，另需本机智能体及配对桥接；插件不打包这些工具。
旧版插件用户可在同一安装路径更新并重新加载；学习资料仍保存在原浏览器中。
模型资源按档位选择后下载，本包不含模型权重、登录态、课程或用户资料。

当前项目还不够完善，如有问题或建议欢迎到 https://github.com/lby749/Vidence/issues 提出，非常感谢！
感谢您的支持，如果有帮助的话，请点一个 STAR，谢谢！
'''.encode('utf8'))
    archive.write(root/'LICENSE','Vidence-Extension/LICENSE.txt')
    archive.write(root/'docs/licenses.md','Vidence-Extension/第三方声明.md')
with output.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n',encoding='utf8')
print(json.dumps({'archive':str(output),'bytes':output.stat().st_size,'browserKernelBundled':False,'desktopRuntimeBundled':False,'modelWeightsBundled':False,'sha256':digest}))
