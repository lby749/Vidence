"""随发行包保留依赖原始声明；不改变依赖许可证。"""
from importlib.metadata import distribution
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
assert root in output.parents and (output / '视频记忆助手.exe').is_file()
notices = output / '_internal/notices'
cache = root / 'artifacts/license-cache'
cache.mkdir(parents=True, exist_ok=True)

for file in (root / 'node_modules').rglob('*'):
    if file.is_file() and file.name.lower().startswith(('license', 'notice', 'copyright')) and file.suffix.lower() in ('', '.txt', '.md'):
        target = notices / 'npm' / file.relative_to(root / 'node_modules')
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(file, target)
for name in ['PySide6', 'PySide6_Essentials', 'PySide6_Addons', 'shiboken6']:
    package = distribution(name)
    for file in package.files:
        if 'licenses/' in str(file).replace('\\', '/'):
            target = notices / name / Path(file).name
            target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(package.locate_file(file), target)
for file in Path(sys.base_prefix).glob('LICENSE*'):
    if file.is_file():
        target = notices / 'Python' / file.name
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(file, target)

node = shutil.which('node')
assert node
version = subprocess.run([node, '--version'], check=True, capture_output=True, text=True).stdout.strip()
sources = {'Node-LICENSE.txt': f'https://raw.githubusercontent.com/nodejs/node/{version}/LICENSE', 'Qt-LGPL-3.0.txt': 'https://raw.githubusercontent.com/qt/qtbase/6.11/LICENSES/LGPL-3.0-only.txt', 'Qt-GPL-3.0.txt': 'https://raw.githubusercontent.com/qt/qtbase/6.11/LICENSES/GPL-3.0-only.txt'}
for name, url in sources.items():
    saved = cache / (version + '-' + name)
    if not saved.exists():
        with urllib.request.urlopen(url, timeout=30) as response: data = response.read()
        assert len(data) > 1000 and b'<html' not in data[:100].lower()
        saved.write_bytes(data)
    notices.mkdir(parents=True, exist_ok=True); shutil.copy2(saved, notices / name)
print('THIRD_PARTY_NOTICES', len([file for file in notices.rglob('*') if file.is_file()]))
