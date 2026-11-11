"""生成并搬移验收普通用户包；开发机验证工具，不进入用户发布包。"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
package = (root / sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'dist/desktop-player/Vidence'
assert root in package.parents
assert all((package / name).is_file() for name in ('一键启动.exe', '一键安装到浏览器.cmd', 'Vidence.exe'))
files = [file for file in package.rglob('*') if file.is_file()]
assert not any(file.suffix.lower() in ('.onnx', '.gguf', '.safetensors', '.tar', '.db', '.sqlite') or file.name == 'token' for file in files)
archive = root / 'dist/Vidence-Windows-x64.zip'
temporary_archive = archive.with_suffix('.zip.part')
with zipfile.ZipFile(temporary_archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as bundle:
    for file in files: bundle.write(file, Path(package.name) / file.relative_to(package))
temporary_archive.replace(archive)
print('Portable ZIP ready; checking a relocated copy with system runtimes removed from PATH.', flush=True)
node = shutil.which('node')
assert node, '开发验收需要Node，用户启动不需要'
with tempfile.TemporaryDirectory(prefix='portable-check-', dir=root / '.desktop-build') as temporary:
    temporary = Path(temporary).resolve()
    assert root / '.desktop-build' in temporary.parents
    with zipfile.ZipFile(archive) as bundle:
        for name in bundle.namelist():
            assert temporary in (temporary / name).resolve().parents
        bundle.extractall(temporary)
    relocated = temporary / package.name
    env = dict(os.environ, PATH=str(Path(os.environ['SystemRoot']) / 'System32'), QT_QPA_PLATFORM='offscreen', LOCALAPPDATA=str(temporary / 'appdata'))
    for name in ('PYTHONHOME', 'PYTHONPATH', 'NODE_OPTIONS', 'QTWEBENGINE_REMOTE_DEBUGGING', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'):
        env.pop(name, None)
    assert not shutil.which('python', path=env['PATH']) and not shutil.which('node', path=env['PATH'])
    report_path = root / 'artifacts/launcher-no-environment.json'
    subprocess.run([str(relocated / '一键启动.exe'), '--self-check', str(report_path)], env=env, check=True, timeout=30)
    report = json.loads(report_path.read_text(encoding='utf-8'))
    assert report['passed'] and report['frozen'] and report['nativePlaybackAndWebBindingsImported']
    bundled_node = relocated / '_internal/runtime/node.exe'
    subprocess.run([str(bundled_node), str(root / 'scripts/packaged-bridge-check.mjs'), str(relocated / '_internal')], env=env, check=True, timeout=20)
    extension = Path(env['LOCALAPPDATA']) / 'VideoMemoryAssistant/browser-extension'
    shutil.copytree(relocated / '_internal/.output/chrome-mv3', extension)
    subprocess.run([node, str(root / 'scripts/installed-extension-check.mjs'), str(extension), str(temporary / 'browser-profile'), str(relocated / '_internal')], env=env, check=True, timeout=60)
with archive.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
report = {'passed': True, 'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest, 'packageFiles': len(files), 'bundledModelWeights': 0, 'relocatedPackage': True, 'systemPythonOnPath': False, 'systemNodeOnPath': False, 'bundledNativeBindings': True, 'bundledNodeBridge': True, 'headlessEdgeExtensionLoad': True, 'freshWindowsVmTested': False, 'missingWebviewInstall': 'mocked-branch-only-host-already-has-runtime', 'dailyBrowserTouched': False}
(root / 'artifacts/portable-release-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=True), flush=True)
