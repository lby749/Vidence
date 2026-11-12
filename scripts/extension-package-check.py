"""在全新目录验证最终插件ZIP；开发工具只用于验收，不进入发行包。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
archive = Path(sys.argv[1]).resolve()
with archive.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
assert archive.with_suffix('.zip.sha256').read_text(encoding='utf8').split()[0] == digest
with tempfile.TemporaryDirectory(prefix='vidence-extension-') as temporary:
    target = Path(temporary).resolve()
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        for item in bundle.infolist():
            destination = (target / item.filename).resolve()
            assert target in destination.parents, '非法解压路径'
            assert destination.suffix.lower() not in ('.exe', '.dll', '.onnx', '.gguf', '.tar', '.tgz', '.bin', '.db', '.sqlite', '.safetensors')
            assert not any(word in item.filename.lower() for word in ('webengine', 'chromium', 'desktop.html', '.local-agent', 'token.json'))
        bundle.extractall(target)
    package = target / 'Vidence-Extension'
    extension = package / 'extension'
    manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf8'))
    assert manifest['manifest_version'] == 3
    assert manifest['version'] == json.loads((root / 'package.json').read_text(encoding='utf8'))['version'].replace('-beta.', '.')
    assert not manifest.get('externally_connectable'), '插件不得开放外站无约束调用'
    assert (package / '安装插件.ps1').read_bytes().startswith(b'\xef\xbb\xbf')
    assert any((package / 'notices').rglob('LICENSE*')), '缺少原始第三方声明'
    environment = {**os.environ, 'VMA_EXTENSION_PATH': str(extension), 'E2E_HEADLESS': '1'}
    if sys.platform == 'win32':
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(root / 'scripts/extension-installer-check.ps1'), str(package)], check=True, cwd=root, env=environment)
    subprocess.run(['node', 'scripts/installed-extension-check.mjs', str(extension), str(target / 'profile')], check=True, cwd=root, env=environment)
    for script in ['e2e.mjs', 'extension-api-check.mjs', 'settings-ui.mjs', 'update-ui-check.mjs']:
        subprocess.run(['node', f'scripts/{script}'], check=True, cwd=root, env=environment)
print('EXTENSION_PACKAGE_PASS', json.dumps({'sha256': digest, 'bytes': archive.stat().st_size, 'relocated': True, 'bundledBrowser': False, 'bundledDesktop': False, 'bundledModels': False}))
