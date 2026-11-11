"""生成带真实独立帧的移动测试图，检查整数/小数帧率和不同分辨率。"""
from pathlib import Path
import json
import subprocess
import sys
import shutil
from fractions import Fraction

root = Path(__file__).resolve().parents[1]
folder = root / 'artifacts/playback-matrix'
folder.mkdir(parents=True, exist_ok=True)
cases = [('720p-60', '1280x720', '60'), ('1080p-59.94', '1920x1080', '60000/1001'), ('1080p-29.97', '1920x1080', '30000/1001'), ('4k-23.976', '3840x2160', '24000/1001'), ('4k-60', '3840x2160', '60')]
results = []
ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
assert ffmpeg and ffprobe, '验收需先安装FFmpeg/ffprobe；普通用户播放不依赖它们'
for name, size, rate in cases:
    video = folder / f'{name}.mp4'
    if not video.exists():
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate={rate}', '-t', '12', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(video)], check=True, timeout=120)
    stream = json.loads(subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate', '-of', 'json', str(video)], capture_output=True, text=True, check=True).stdout)['streams'][0]
    assert Fraction(stream['avg_frame_rate']) == Fraction(rate)
    assert f"{stream['width']}x{stream['height']}" == size
    report = f'cadence-{name}.json'
    with (folder / f'{name}.log').open('w', encoding='utf-8') as log:
        tested = subprocess.run([sys.executable, '-X', 'utf8', str(root / 'scripts/playback-cadence-check.py'), '--onscreen', '--source', str(video), '--fps', rate, '--output', report], stdout=log, stderr=log, timeout=30)
    result = json.loads((root / 'artifacts' / report).read_text(encoding='utf-8'))
    result['exitCode'] = tested.returncode
    result['sourceProbe'] = stream
    results.append(result)
    (root / 'artifacts/playback-matrix.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps({'case': name, 'fps': result.get('deliveredFps'), 'sizes': result.get('decodedSizes'), 'passed': result.get('passed', False)}), flush=True)
assert all(result.get('passed') for result in results)
