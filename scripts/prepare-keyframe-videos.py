"""为本次选帧验收缓存公开B站视频；不读取浏览器账号或登录信息。"""
from pathlib import Path
import concurrent.futures
import json
import sys
import urllib.parse
import urllib.request

root = Path(__file__).resolve().parents[1] / 'artifacts/keyframe-audit'
headers = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/'}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        body = json.load(response)
    if body.get('code') != 0: raise RuntimeError('公开接口未返回可用视频')
    return body['data']


def prepare(bvid):
    assert len(bvid) == 12 and bvid.startswith('BV') and bvid.isalnum()
    view = get_json('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid)
    data = get_json('https://api.bilibili.com/x/player/playurl?' + urllib.parse.urlencode({'bvid': bvid, 'cid': view['cid'], 'qn': 64, 'fnval': 1}))
    streams = data.get('durl', [])
    assert len(streams) == 1 and streams[0]['size'] < 320_000_000, '本次只验收单段公开普通清晰度视频'
    directory = root / bvid; directory.mkdir(exist_ok=True)
    file = directory / 'video.mp4'; expected = streams[0]['size']
    if not file.exists() or file.stat().st_size != expected:
        print(bvid, view['title'], 'downloading', expected, flush=True)
        temporary = directory / 'video.mp4.part'
        with urllib.request.urlopen(urllib.request.Request(streams[0]['url'], headers=headers), timeout=30) as response, temporary.open('wb') as output:
            downloaded = 0; reported = 0
            while chunk := response.read(256 * 1024):
                output.write(chunk); downloaded += len(chunk)
                if downloaded - reported >= 32 * 1024 * 1024:
                    print(bvid, downloaded, '/', expected, flush=True); reported = downloaded
        assert temporary.stat().st_size == expected
        temporary.replace(file)
    metadata = {'bvid': bvid, 'title': view['title'], 'duration': view['duration'], 'quality': data['quality'], 'format': data['format'], 'bytes': expected, 'source': 'public-bilibili-api-no-login', 'file': str(file)}
    (directory / 'source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    print('VIDEO_READY', json.dumps(metadata, ensure_ascii=False), flush=True)


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for result in pool.map(prepare, sys.argv[1:]): pass
