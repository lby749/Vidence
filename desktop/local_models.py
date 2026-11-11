"""下载资源与原生检索模型。GPU 优先，加载或推理失败后重试 CPU；不在推理时下载。"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request


class LocalModels:
    def __init__(self, root, state):
        self.spec = json.loads((root / 'src/models/desktop-embedding.json').read_text('utf8'))
        self.file = state / 'models' / self.spec['name']
        self.runtime = root / 'desktop/runtime/llama'
        self.process = None
        self.origin = None
        self.backend = None
        self.fallback = None
        self.log = ''
        self.verified = False
        self.generation = 0
        self.lock = threading.RLock()
        self.encoding = threading.Lock()
        self.installing = threading.Lock()

    def installed(self):
        return self.file.is_file() and self.file.stat().st_size == self.spec['bytes']

    def status(self):
        return {'installed': self.installed(), 'loaded': bool(self.process and self.process.poll() is None), 'backend': self.backend, 'fallback': self.fallback}

    def download(self, progress):
        with self.installing:
            if self.installed():
                try:
                    self.verify()
                    progress(self.spec['bytes'], self.spec['bytes'])
                    return
                except ValueError: self.verified = False
            self.file.parent.mkdir(parents=True, exist_ok=True)
            partial = self.file.with_suffix('.partial')
            digest = hashlib.sha256()
            loaded = 0
            with urllib.request.urlopen(self.spec['url'], timeout=30) as response, partial.open('wb') as output:
                while chunk := response.read(512 * 1024):
                    loaded += len(chunk)
                    if loaded > self.spec['bytes']: raise ValueError('下载文件大小异常')
                    digest.update(chunk)
                    output.write(chunk)
                    progress(loaded, self.spec['bytes'])
            if loaded != self.spec['bytes'] or digest.hexdigest() != self.spec['sha256']:
                raise ValueError('下载校验失败，请重新下载')
            partial.replace(self.file)
            self.verified = True

    def verify(self):
        if self.verified: return
        if not self.installed(): raise ValueError('请先在设置 → 离线功能中下载中占用或高占用资源')
        digest = hashlib.sha256()
        with self.file.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''): digest.update(chunk)
        if digest.hexdigest() != self.spec['sha256']: raise ValueError('模型文件校验失败，请重新下载')
        self.verified = True

    def unload(self):
        with self.lock:
            self.generation += 1
            process, self.process = self.process, None
            self.origin = None
            self.backend = None
        if process and process.poll() is None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)

    def request(self, path, payload=None):
        request = urllib.request.Request(self.origin + path, data=json.dumps(payload).encode() if payload is not None else None, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response: return json.load(response)

    def start(self, cpu=False):
        with self.lock:
            if self.process and self.process.poll() is None: return
            self.verify()
            backends = ['cpu'] if cpu else (['metal', 'cpu'] if sys.platform == 'darwin' else ['vulkan', 'cpu'])
            errors = []
            for backend in backends:
                executable = self.runtime / backend / ('llama-server.exe' if os.name == 'nt' else 'llama-server')
                if not executable.exists(): continue
                device = None
                if backend != 'cpu':
                    try:
                        probe = subprocess.run([str(executable), '--list-devices'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                        match = re.search(r'^\s*((?:Vulkan|Metal)\d*):', probe.stdout.decode('utf8', errors='replace'), re.MULTILINE)
                        if probe.returncode or not match: errors.append(backend); continue
                        device = match[1]
                    except (OSError, subprocess.TimeoutExpired): errors.append(backend); continue
                with socket.socket() as reservation:
                    reservation.bind(('127.0.0.1', 0))
                    port = reservation.getsockname()[1]
                command = [str(executable), '--model', str(self.file), '--embedding', '--pooling', 'mean', '--ctx-size', '512', '--batch-size', '512', '--ubatch-size', '512', '--threads', '2', '--threads-batch', '2', '--parallel', '1', '--n-gpu-layers', '0' if backend == 'cpu' else '99', '--host', '127.0.0.1', '--port', str(port), '--no-warmup']
                if device: command += ['--device', device]
                self.log = ''
                process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                def collect(child=process):
                    for line in iter(child.stderr.readline, b''): self.log = (self.log + line.decode('utf8', errors='replace'))[-32000:]
                threading.Thread(target=collect, daemon=True).start()
                self.process, self.origin = process, f'http://127.0.0.1:{port}'
                for _ in range(150):
                    if process.poll() is not None: break
                    try:
                        self.request('/health')
                        self.backend = backend
                        self.fallback = '显卡加速不可用，已使用处理器' if errors else None
                        return
                    except Exception: time.sleep(.2)
                errors.append(backend)
                if process.poll() is None: process.terminate(); process.wait(timeout=5)
                self.process, self.origin = None, None
            raise RuntimeError('离线计算运行时不可用，请检查安装文件是否完整')

    def embed(self, texts):
        if not isinstance(texts, list) or not 1 <= len(texts) <= 64 or any(not isinstance(text, str) or len(text) > 100000 for text in texts):
            raise ValueError('文本数量或长度无效')
        epoch = self.generation
        with self.encoding:
            if epoch != self.generation: raise RuntimeError('占用档位已切换，本地计算已停止')
            self.start()
            vectors = []
            for text in texts:
                try:
                    tokens = self.request('/tokenize', {'content': text, 'add_special': True})['tokens'][:512]
                    vector = self.request('/v1/embeddings', {'input': tokens})['data'][0]['embedding']
                except Exception:
                    with self.lock:
                        if epoch != self.generation: raise RuntimeError('占用档位已切换，本地计算已停止') from None
                        if self.backend == 'cpu': raise
                        self.unload()
                        epoch = self.generation
                        self.start(cpu=True)
                        self.fallback = '显卡计算未完成，已自动改用处理器'
                    tokens = self.request('/tokenize', {'content': text, 'add_special': True})['tokens'][:512]
                    vector = self.request('/v1/embeddings', {'input': tokens})['data'][0]['embedding']
                if epoch != self.generation: raise RuntimeError('占用档位已切换，本地计算已停止')
                if len(vector) != self.spec['dimension']: raise RuntimeError('模型返回维度异常')
                vectors.append(vector)
            return {'vectors': vectors, 'dim': self.spec['dimension'], 'backend': self.backend, 'fallback': self.fallback}
