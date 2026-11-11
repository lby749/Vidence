"""按真实30fps媒体第75帧采样；只为离线验收生成像素和缩略图。"""
from pathlib import Path
import json
import subprocess
import sys
from PIL import Image

root = Path(__file__).resolve().parents[1] / 'artifacts/keyframe-audit'
for bvid in sys.argv[1:]:
    directory = root / bvid
    metadata = json.loads((directory / 'source.json').read_text(encoding='utf-8'))
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', str(directory / 'video.mp4')], capture_output=True, text=True, check=True)
    stream = json.loads(probe.stdout)['streams'][0]; assert stream['r_frame_rate'] == '30/1'
    metadata['originalResolution'] = [stream['width'], stream['height']]
    (directory / 'source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(directory / 'video.mp4'), '-vf', r'select=not(mod(n\,75)),scale=320:180', '-fps_mode', 'vfr', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-y', str(directory / 'samples.rgba')], check=True)
    output = directory / 'source'; output.mkdir(exist_ok=True)
    size = 320 * 180 * 4; index = 0
    with (directory / 'samples.rgba').open('rb') as frames:
        while data := frames.read(size):
            assert len(data) == size
            Image.frombytes('RGBA', (320, 180), data).convert('RGB').save(output / f'{index:03d}.jpg', quality=92)
            index += 1
    print('SAMPLED_REAL_VIDEO', bvid, index, flush=True)
