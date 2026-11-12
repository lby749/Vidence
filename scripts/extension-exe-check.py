"""Run the relocated final EXE with only system PATH and an isolated destination."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
exe = Path(sys.argv[1]).resolve()
with exe.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
assert exe.with_suffix('.exe.sha256').read_text(encoding='utf8').split()[0] == digest
report = root / 'artifacts/extension-exe-check.json'
report.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='Vidence setup with spaces-') as temporary:
    relocated = Path(temporary) / exe.name
    shutil.copy2(exe, relocated)
    environment = {**os.environ, 'PATH': str(Path(os.environ['WINDIR']) / 'System32')}
    subprocess.run([str(relocated), '--verify', str(report)], cwd=temporary, env=environment, check=True, timeout=90)
    result = json.loads(report.read_text(encoding='utf8'))
    assert result['passed'] and result['install'] and result['update']
    assert result['version'] == json.loads((root / 'package.json').read_text(encoding='utf8'))['version']
    assert result['adjacentLearningDataPreserved'] and result['staleAssetsRemoved'] and result['traversalRejected']
    assert result['browserOpened'] is False
    assert list(Path(temporary).iterdir()) == [relocated], '安装器不依赖相邻运行时文件'
print('EXTENSION_EXE_PASS', json.dumps({**result, 'exeBytes': exe.stat().st_size, 'exeSha256': digest, 'pathOnlySystem32': True}))
