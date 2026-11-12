"""真实 GPU/CPU 推理与一次设备失败注入；只使用隔离测试状态，结束后关闭本脚本的模型进程。"""
import json
from pathlib import Path
import shutil
import sys
import time

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'desktop'))
from local_models import LocalModels

state = root / 'artifacts/native-embedding-state'
models = LocalModels(root, state)
models.file.parent.mkdir(parents=True, exist_ok=True)
if not models.file.exists(): shutil.copyfile(root / 'artifacts/q4-evaluation/embeddinggemma-300m-Q4_K_M.gguf', models.file)
models.download_runtime(lambda loaded,total:None)
texts = [models.spec['queryInstruction'] + '植物如何利用阳光生产有机物？', models.spec['documentInstruction'] + '光合作用将光能转化为化学能，并利用二氧化碳合成有机物。', models.spec['documentInstruction'] + 'SUM 函数可以求一列数字的总和。']
report = {'at': time.time(), 'scope': 'real-native-inference-and-injected-device-failure'}
try:
    start = time.monotonic()
    actual = models.embed(texts)
    report['gpu'] = {'backend': actual['backend'], 'fallback': actual['fallback'], 'elapsedSeconds': time.monotonic() - start, 'dim': actual['dim']}
    assert actual['backend'] == 'vulkan', models.log
    query, relevant, other = actual['vectors']
    assert sum(a*b for a,b in zip(query,relevant)) > sum(a*b for a,b in zip(query,other))
    original = models.request
    failed = [False]
    def fail_once(path, payload=None):
        if path == '/v1/embeddings' and not failed[0]:
            failed[0] = True
            raise RuntimeError('injected device loss')
        return original(path, payload)
    models.request = fail_once
    fallback = models.embed(texts)
    assert fallback['backend'] == 'cpu'
    agreement = sum(a*b for a,b in zip(query, fallback['vectors'][0]))
    assert agreement > .999, agreement
    report['cpuFallback'] = {'backend': fallback['backend'], 'cosineAgreement': agreement, 'trigger': 'injected request error after real GPU success'}
    report['passed'] = True
finally:
    models.unload()
    report['workerStopped'] = models.process is None
    (root / 'artifacts/native-embedding-check.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps(report), flush=True)
