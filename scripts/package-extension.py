"""独立浏览器插件包：仅扩展资源与许可，无浏览器内核或桌面运行时。"""
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
    assert file.suffix.lower() not in ('.exe','.dll','.onnx','.gguf','.safetensors','.db','.sqlite','.pyc','.tar','.tgz','.bin','.cmd','.ps1','.bat')
    assert file.name!='desktop.html' and 'webengine' not in file.name.lower()
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for file in files:archive.write(file,file.relative_to(source))
    archive.writestr('使用说明.txt','''Vidence · 独立浏览器插件

Vidence 帮你在浏览器看视频时提问、整理重点、保存每个视频的学习记忆。

本包是纯插件，不含安装程序、命令脚本、桌面应用、浏览器内核或模型权重。
手动安装：完整解压，打开 edge://extensions/ 或 chrome://extensions/，开启开发者模式，
点击“加载已解压的扩展”，选择包含 manifest.json 的文件夹。
保留这个文件夹，浏览器会继续从此处读取插件。Windows 用户也可单独下载 EXE 安装引导，
无需解压，它会安装同一套插件文件并打开浏览器安装页。

已安装用户：先导出备份，保持原浏览器与安装目录，更新文件后点击“重新加载”，不要先卸载。
学习资料保存在原浏览器，不在插件代码目录中。浏览器要求用户亲自确认首次加载。
API 问答不依赖桌面程序；可在设置里粘贴自己的 API Key，获取模型并测试连接。
可选的 OpenCode Go / DSH 等本机智能体及桥接需要用户另行安装，本包不附带它们。

当前项目仍在完善，问题与建议欢迎到 https://github.com/lby749/Vidence/issues 提出，非常感谢！
感谢您的支持，如果有帮助的话，请点一个 STAR，谢谢！
'''.encode('utf8'))
    # 保留实际生产依赖的原始声明，开发工具不进入插件包。
    packages=json.loads((root/'package-lock.json').read_text(encoding='utf8'))['packages']
    for location, package in packages.items():
        if not location or package.get('dev'): continue
        directory=root/location
        for notice in directory.glob('*'):
            if notice.is_file() and notice.name.lower().startswith(('license','notice','copyright')):
                archive.write(notice,Path('notices')/notice.relative_to(root/'node_modules'))
        for notice in (directory/'LICENSES').rglob('*'):
            if notice.is_file(): archive.write(notice,Path('notices')/notice.relative_to(root/'node_modules'))
    archive.write(root/'LICENSE' ,'LICENSE.txt')
    archive.write(root/'docs/licenses.md','第三方声明.md')
with output.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n',encoding='utf8')
print(json.dumps({'archive':str(output),'bytes':output.stat().st_size,'browserKernelBundled':False,'desktopRuntimeBundled':False,'modelWeightsBundled':False,'sha256':digest}))
