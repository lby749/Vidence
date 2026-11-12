"""搬移验收原生桌面包；扩展使用独立的package-extension.py。"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
root=Path(__file__).resolve().parents[1]
package=(root/sys.argv[1]).resolve() if len(sys.argv)>1 else root/'dist/desktop-player/Vidence'
assert root in package.parents
assert all((package/name).is_file() for name in ('一键启动.exe','Vidence.exe'))
files=[file for file in package.rglob('*') if file.is_file()]
assert not any(file.suffix.lower() in ('.onnx','.gguf','.safetensors','.db','.sqlite') or file.name=='token' or 'webengine' in file.name.lower() for file in files)
assert not (package/'_internal/.output').exists()
archive=(root/sys.argv[2]).resolve() if len(sys.argv)>2 else root/'dist/Vidence-Desktop-Windows-x64.zip'
assert root in archive.parents and not archive.exists(),'请选择新的输出文件，不覆盖已发布资产'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as bundle:
    for file in files:bundle.write(file,Path(package.name)/file.relative_to(package))
with tempfile.TemporaryDirectory(prefix='native-portable-',dir=root/'.desktop-build') as directory:
    temporary=Path(directory).resolve()
    with zipfile.ZipFile(archive) as bundle:
        assert all((temporary/name).resolve().is_relative_to(temporary) for name in bundle.namelist())
        bundle.extractall(temporary)
    relocated=temporary/package.name
    env=dict(os.environ,PATH=str(Path(os.environ['SystemRoot'])/'System32'),QT_QPA_PLATFORM='offscreen',LOCALAPPDATA=str(temporary/'appdata'))
    for name in ('PYTHONHOME','PYTHONPATH','NODE_OPTIONS','QTWEBENGINE_REMOTE_DEBUGGING','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'):env.pop(name,None)
    assert not shutil.which('python',path=env['PATH']) and not shutil.which('node',path=env['PATH'])
    report_path=root/'artifacts/native-relocated-check.json'
    args=[str(relocated/'一键启动.exe'),'--self-check',str(report_path)]
    media=root/'artifacts/playback-matrix/720p-60.mp4'
    if media.is_file():args+=['--media',str(media)]
    subprocess.run(args,env=env,check=True,timeout=45)
    report=json.loads(report_path.read_text(encoding='utf8')); assert report['passed'] and report['nativeSidebarConstructed'] and not report['bundledBrowserKernel'] and not report['extensionBundled']
    subprocess.run([str(relocated/'_internal/runtime/node.exe'),str(root/'scripts/packaged-bridge-check.mjs'),str(relocated/'_internal')],env=env,check=True,timeout=20)
with archive.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n',encoding='utf8')
report={'passed':True,'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest,'packageFiles':len(files),'bundledModelWeights':False,'bundledBrowserKernel':False,'bundledExtension':False,'relocatedPackage':True,'systemPythonOnPath':False,'systemNodeOnPath':False,'physicallyEmptyWindowsTested':False}
(root/'artifacts/native-portable-check.json').write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report),flush=True)
