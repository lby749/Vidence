"""生成可点开原清晰度的选帧审阅页；全部为实际视频帧，不生成替代画面。"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import html
import json
import math
import subprocess
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
base = root / 'artifacts/keyframe-audit'
font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 15)
reports = []
for code in ['BV1G7jJ6nEbV', 'BV1hvi1YVE2Z', 'BV1ge4y1V7RS', '']:
    folder = base / code
    report = json.loads((folder / 'comparison.json').read_text(encoding='utf-8'))
    video = folder / 'video.mp4' if code else Path('D:/Desktop/梵高_介绍.mp4')
    output = folder / 'full'; output.mkdir(exist_ok=True)
    indices = sorted({round(frame['actualImageTime'] / 2.5) for version in ('before', 'after') for frame in report[version]})
    def capture(index):
        target = output / f'{index}.jpg'
        if not target.exists():
            subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(index * 2.5), '-i', str(video), '-frames:v', '1', '-vf', r'scale=min(1280\,iw):-2', '-q:v', '2', '-an', '-y', str(target)], capture_output=True, check=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(capture, indices))
    for page in range(math.ceil(len(report['after']) / 12)):
        frames = report['after'][page * 12:(page + 1) * 12]
        contact = Image.new('RGB', (1280, math.ceil(len(frames) / 4) * 215 + 35), '#f5f5f7'); draw = ImageDraw.Draw(contact)
        draw.text((10, 8), (code or 'Local art lesson') + ' / ' + str(page + 1), font=font, fill='#222')
        for i, frame in enumerate(frames):
            x, y = i % 4 * 320, i // 4 * 215 + 35
            contact.paste(Image.open(folder / frame['image']), (x, y)); draw.text((x + 6, y + 183), str(frame['time']) + 's', font=font, fill='#222')
        contact.save(folder / f'after-page-{page+1}.png')
    reports.append({'source': report['source'], 'code': code, 'duration': report['duration'], 'before': len(report['before']), 'after': len(report['after']), 'first': report['after'][0]['time'], 'last': report['after'][-1]['time']})
    print('FULL_RESOLUTION_REVIEW_READY', code or 'art', len(indices), flush=True)
rows = ''.join(f'<tr><td><a href="{row["code"]+"/" if row["code"] else ""}comparison.html">{html.escape(row["source"])}</a></td><td>{row["duration"]}秒</td><td>{row["before"]} → {row["after"]}</td><td>{row["first"]}–{row["last"]}秒</td></tr>' for row in reports)
(base / 'index.html').write_text('''<!doctype html><meta charset="utf-8"><title>关键画面验收</title><style>body{font:16px system-ui;color:#1d1d1f;background:#f5f5f7;margin:60px auto;padding:24px;max-width:1100px}h1{font-size:36px}table{border-collapse:collapse;width:100%;background:white;border-radius:18px}td,th{text-align:left;padding:18px;border-bottom:1px solid #eee}a{color:#0071e3}p{line-height:1.8;color:#555}</style><h1>关键画面，是否值得留下？</h1><p>三段公开B站知识视频与一段本地视频，均对完整视频每2.5秒的实际解码画面重放新旧保存链路。点视频标题比较，点图片查看原清晰度。</p><table><thead><tr><th>视频</th><th>时长</th><th>保存数量</th><th>新版首末截图</th></tr></thead><tbody>'''+rows+'''</tbody></table><p>数量不是准确率。人工抽查可以看到几何图、公式、地球运动图解和表格操作前后状态，但讲者与片尾仍可能混入。当前是本地视觉变化筛选，不宣称已理解每个知识重点。没有自动调用云端视觉模型。</p><p>长视频按已知时长为后段保留预算；未知时长的外部窗口不猜测课程长度。这里是原媒体像素重放，单列真实扩展截图与桌面UI验收，不冒充本轮日常账号页面实测。</p>''', encoding='utf-8')
(base / 'review-summary.json').write_text(json.dumps({'scope': 'full-source-decoded-replay-and-manual-spot-review', 'videos': reports, 'semanticAccuracyClaim': False, 'sourceVideosPackaged': False}, ensure_ascii=False, indent=2), encoding='utf-8')
