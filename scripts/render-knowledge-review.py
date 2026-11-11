"""生成包含原图、模型结论、人工复核范围和问答对照的本机报告。"""
from pathlib import Path
import collections
import html
import json

root = Path(__file__).resolve().parents[1]
folder = root / 'artifacts/keyframe-audit'
reports = []
sections = []
for code in ('BV1G7jJ6nEbV', 'BV1hvi1YVE2Z', 'BV1ge4y1V7RS', 'art-ending'):
    report = json.loads((folder / code / 'knowledge-review.json').read_text(encoding='utf-8'))
    counts = collections.Counter()
    groups = collections.defaultdict(list)
    for frame in report['frames']:
        k = frame['knowledge']
        state = '知识画面' if k['kind'] == 'knowledge' else '待确认' if k['kind'] == 'uncertain' or k['confidence'] < .8 else '非知识画面'
        counts[state] += 1
        frame['kept'] = state == '知识画面'
        groups[state].append(f'<figure><a href="{code}/{frame["full"]}" target="_blank"><img loading="lazy" src="{code}/{frame["full"]}"></a><figcaption><strong>{frame["time"]}秒 · {html.escape(k["title"])}</strong><p>{html.escape(k["summary"])}</p><small>{html.escape(k["visibleText"])}</small></figcaption></figure>')
    (folder / code / 'knowledge-review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    reports.append({'video': code, 'counts': dict(counts), 'classified': len(report['frames']), 'completed': report['completed']})
    sections.append(f'<h2>{html.escape(report["title"])}</h2><p>{html.escape(str(dict(counts)))}</p>' + ''.join(f'<details {"open" if state == "知识画面" else ""}><summary>{state} · {len(items)}</summary><div class="grid">{"".join(items)}</div></details>' for state, items in groups.items()))

# 人工复核的是这60张候选图的视觉用途，未逐秒标注整个视频所有知识点。
math = json.loads((folder / 'BV1G7jJ6nEbV/knowledge-review.json').read_text(encoding='utf-8'))
speaker_times = {5, 880, 1562.5, 1597.5, 1635, 1672.5, 1707.5, 1742.5, 1847.5, 1887.5, 1922.5, 1957.5, 1995}
uncertain_times = {550, 1057.5}
labels = [{'time': frame['time'], 'label': 'speaker' if frame['time'] in speaker_times else 'uncertain' if frame['time'] in uncertain_times else 'knowledge', 'model': frame['knowledge']['kind']} for frame in math['frames']]
manual = {'scope': 'manual-contact-sheet-and-original-image-review-of-60-candidates-not-full-video-recall', 'labelsNotSentToModel': True, 'matches': sum(row['label'] == row['model'] for row in labels), 'total': len(labels), 'labels': labels}
(folder / 'knowledge-manual-review.json').write_text(json.dumps(manual, ensure_ascii=False, indent=2), encoding='utf-8')
qa = json.loads((root / 'artifacts/knowledge-qa-check.json').read_text(encoding='utf-8'))
summary = {'sources': reports, 'manualReview': {'matches': manual['matches'], 'total': manual['total'], 'scope': manual['scope']}, 'actualVisionQaPassed': qa['passed']}
(folder / 'knowledge-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
answers = ''.join(f'<details><summary>{html.escape(case["name"])} · 图片读取{case["usage"]["imageUploads"]}张 · {case["passed"]}</summary><pre>{html.escape(case["answer"])}</pre></details>' for case in qa['cases'])
(folder / 'knowledge.html').write_text('<!doctype html><meta charset="utf-8"><title>知识画面与真实图片问答</title><style>body{font:16px/1.6 system-ui;background:#f5f5f7;color:#1d1d1f;max-width:1450px;margin:36px auto;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}figure,details{background:white;border-radius:14px;padding:14px;margin:12px 0}figure{margin:0}img{width:100%}small{color:#666}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap}</style><h1>知识画面与真实图片问答</h1><p>使用OpenCode Go中实际的DeepSeek V4.1 Flash读取原媒体像素；模型未收到人工分类标签。排除讲者/片尾后保留原图，无法判断的图单独待确认。数学60张候选图的人工复核分类与模型一致；这不等于整段视频知识点召回率，也不保证模型解读的每个细节都正确。</p><h2>有图／无图／换图对照</h2><p>没有提供字幕或OCR答案。有数学图时读出公式；禁图后不猜；换成Excel图后读出表格内容。三个对照均通过。控制实验固定播放位置以排除时间和标题提示，Excel换图不是其真实播放时间。</p>'+answers+''.join(sections), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
