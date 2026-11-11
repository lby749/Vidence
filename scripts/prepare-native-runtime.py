"""准备当前操作系统的已固定版本原生运行时；只有程序，不含模型权重。"""
import hashlib
import json
import platform
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'src/models/native-runtime.json').read_text('utf8'))
system = platform.system().lower()
machine = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x86_64'
backends = ['cpu', 'vulkan'] if system == 'windows' else ['metal'] if system == 'darwin' else []
assert backends, '当前打包脚本支持 Windows 和 macOS'
cache = root / 'artifacts/native-runtime'
cache.mkdir(parents=True, exist_ok=True)
for backend in backends:
    spec = manifest['platforms'][f'{system}-{machine}-{backend}']
    archive = cache / spec['name']
    if not archive.exists():
        partial = archive.with_suffix(archive.suffix + '.partial')
        subprocess.run(['curl.exe' if system == 'windows' else 'curl', '-L', '--fail', '--silent', '--show-error', '--retry', '2', '-o', str(partial), spec['url']], check=True)
        partial.rename(archive)
    assert archive.stat().st_size == spec['bytes']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == spec['digest'].split(':')[1]
    dest = (root / 'desktop/runtime/llama' / backend).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as bundle:
            assert all((dest / item.filename).resolve().is_relative_to(dest) for item in bundle.infolist())
            bundle.extractall(dest)
    else:
        with tarfile.open(archive) as bundle: bundle.extractall(dest, filter='data')
        # 官方 macOS 包有顶层目录；只展平本次明确下载的运行时文件。
        executable = next(dest.rglob('llama-server'))
        if executable.parent != dest:
            for file in executable.parent.iterdir():
                if file.is_file(): shutil.copy2(file, dest / file.name)
    if backend == 'metal':
        cpu = root / 'desktop/runtime/llama/cpu'
        cpu.mkdir(parents=True, exist_ok=True)
        for file in dest.iterdir():
            if file.is_file(): shutil.copy2(file, cpu / file.name)
    print('VERIFIED', backend, flush=True)
