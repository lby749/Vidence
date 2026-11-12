"""原生桌面的学习数据；SQLite持久保存，每次读取明确限定视频。"""
import base64
from contextlib import contextmanager
import json
import math
from pathlib import Path
import sqlite3
import time


KINDS = ('sessions', 'evidence', 'nodes', 'keyframes', 'chats', 'longMemories', 'vectors')


class NativeStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records(
                    kind TEXT NOT NULL, video_id TEXT NOT NULL REFERENCES videos(id),
                    id TEXT NOT NULL, body TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
                    payload TEXT NOT NULL, PRIMARY KEY(kind, video_id, id));
                CREATE INDEX IF NOT EXISTS records_video_time ON records(video_id, kind, start);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
            ''')

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db: yield db
        finally: db.close()

    @staticmethod
    def identifier(value):
        if not isinstance(value, str) or not value or len(value) > 512:
            raise ValueError('记录标识无效')
        return value

    def save_video(self, video):
        identifier = self.identifier(video.get('id'))
        if not isinstance(video.get('title'), str): raise ValueError('视频名称无效')
        with self.connection() as db:
            db.execute('INSERT INTO videos VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (identifier, json.dumps(video, ensure_ascii=False)))

    def video(self, video_id):
        with self.connection() as db:
            row = db.execute('SELECT payload FROM videos WHERE id=?', (video_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def videos(self):
        with self.connection() as db: rows = db.execute('SELECT payload FROM videos ORDER BY rowid DESC').fetchall()
        return [json.loads(row[0]) for row in rows]

    def _put(self, db, kind, video_id, record):
        if kind not in KINDS: raise ValueError('不支持的记录类型')
        self.identifier(video_id)
        if record.get('videoId', video_id) != video_id: raise ValueError('记录来源不属于当前视频')
        if kind=='evidence' and not isinstance(record.get('text'),str):raise ValueError('原文记录格式无效')
        if kind=='chats' and (not isinstance(record.get('question'),str) or not isinstance(record.get('answer',''),str)):raise ValueError('聊天记录格式无效')
        if kind=='nodes' and (not isinstance(record.get('summary',''),str) or not isinstance(record.get('evidenceIds',[]),list)):raise ValueError('笔记格式无效')
        identifier = self.identifier(record.get('id', video_id if kind == 'longMemories' else None))
        start = record.get('startTime', record.get('time', 0))
        end = record.get('endTime', start)
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in (start, end)) or end < start:
            raise ValueError('记录时间范围无效')
        value = dict(record, id=identifier, videoId=video_id)
        body = value.get('text', value.get('body', value.get('summary', value.get('answer', ''))))
        if kind == 'keyframes': body = ' '.join(str(value.get('review', {}).get(key, '')) for key in ('title', 'summary'))
        if not isinstance(body, str): raise ValueError('记录内容无效')
        db.execute('INSERT INTO records VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,video_id,id) DO UPDATE SET body=excluded.body,start=excluded.start,end=excluded.end,payload=excluded.payload',
                   (kind, video_id, identifier, body, start, end, json.dumps(value, ensure_ascii=False)))
        return value

    def put(self, kind, video_id, record):
        with self.connection() as db: return self._put(db, kind, video_id, record)

    def get(self, kind, video_id, identifier):
        with self.connection() as db:
            row = db.execute('SELECT payload FROM records WHERE kind=? AND video_id=? AND id=?', (kind, video_id, identifier)).fetchone()
        return json.loads(row[0]) if row else None

    def rows(self, kind, video_id, start=0, end=None):
        with self.connection() as db:
            rows = db.execute('SELECT payload FROM records WHERE kind=? AND video_id=? AND end>=? AND (? IS NULL OR start<=?) ORDER BY start,rowid', (kind, video_id, start, end, end)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def search(self, video_id, query, start=0, end=None, limit=12):
        if not isinstance(query, str) or not query.strip(): return []
        tokens = list(dict.fromkeys(query.lower().split()))[:12]
        results = []
        with self.connection() as db:
            rows = db.execute("SELECT kind,payload,body FROM records WHERE video_id=? AND kind IN ('evidence','nodes','longMemories','keyframes') AND end>=? AND (? IS NULL OR start<=?) ORDER BY start", (video_id, start, end, end)).fetchall()
        for kind, raw, body in rows:
            score = sum(body.lower().count(token) for token in tokens)
            if score: results.append((score, dict(json.loads(raw), recordType=kind)))
        return [record for score, record in sorted(results, key=lambda value: -value[0])[:max(1, min(limit, 50))]]

    def memory(self, video_id): return self.get('longMemories', video_id, video_id)

    def save_memory(self, video_id, body, sources, locked=False, manual=False):
        if not isinstance(body, str) or not isinstance(sources, list): raise ValueError('记忆内容无效')
        with self.connection() as db:
            previous_row = db.execute("SELECT payload FROM records WHERE kind='longMemories' AND video_id=? AND id=?", (video_id, video_id)).fetchone()
            previous = json.loads(previous_row[0]) if previous_row else None
            if previous and previous.get('locked') and not manual: raise ValueError('这份记忆已锁定，请先解锁或手动编辑')
            for source in sources:
                if source.get('videoId') != video_id or not db.execute("SELECT 1 FROM records WHERE kind='evidence' AND video_id=? AND id=?", (video_id, source.get('evidenceId'))).fetchone():
                    raise ValueError('长期记忆的来源必须属于当前视频')
            versions = previous.get('versions', []) if previous else []
            if previous: versions = (versions + [{k: previous[k] for k in ('body', 'sources', 'revision', 'updatedAt')}])[-20:]
            value = {'id': video_id, 'videoId': video_id, 'body': body, 'sources': sources, 'locked': locked, 'revision': (previous or {}).get('revision', 0) + 1, 'versions': versions, 'updatedAt': int(time.time() * 1000)}
            return self._put(db, 'longMemories', video_id, value)

    def setting(self, key, default=None):
        with self.connection() as db: row = db.execute('SELECT payload FROM settings WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, key, value):
        with self.connection() as db:
            db.execute('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload', (key, json.dumps(value, ensure_ascii=False)))

    def export(self, video_ids):
        videos = [self.video(identifier) for identifier in video_ids]
        if any(video is None for video in videos): raise ValueError('找不到所选视频')
        allowed = ('id', 'title', 'url', 'platform', 'duration', 'customTitle', 'createdAt', 'updatedAt')
        bundle = {'format': 'vma-export', 'version': 1, 'exportedAt': int(time.time() * 1000), 'videos': [{k: v[k] for k in allowed if k in v} for v in videos]}
        for kind in KINDS: bundle[kind] = [row for identifier in video_ids for row in self.rows(kind, identifier)]
        for frame in bundle['keyframes']:
            frame['uploadAllowed']=False
            if frame.get('review'):frame['knowledge']=frame['review']
            if frame.get('manualKeep'):frame['reason']='user'
        return bundle

    def import_bundle(self, bundle):
        if not isinstance(bundle, dict) or bundle.get('format') != 'vma-export' or bundle.get('version') != 1: raise ValueError('不是支持的学习资料导出文件')
        videos = bundle.get('videos')
        if not isinstance(videos, list): raise ValueError('缺少视频列表')
        ids = {self.identifier(v.get('id')) for v in videos}
        if len(ids) != len(videos): raise ValueError('存在重复视频标识')
        with self.connection() as db:
            for video in videos:
                if not isinstance(video.get('title'), str): raise ValueError('视频名称无效')
                db.execute('INSERT OR IGNORE INTO videos VALUES (?,?)', (video['id'], json.dumps(video, ensure_ascii=False)))
            for kind in KINDS:
                rows = bundle.get(kind, [])
                if not isinstance(rows, list): raise ValueError('记录列表格式无效')
                for row in rows:
                    if not isinstance(row, dict) or row.get('videoId') not in ids: raise ValueError('记录引用了其他视频')
                    if kind == 'keyframes':
                        row=dict(row)
                        if row.get('knowledge') and not row.get('review'):row['review']=row['knowledge']
                        row.pop('uploadAllowed',None); row.pop('uploadedAt',None)
                        image = row.get('imageDataUrl', '')
                        if not isinstance(image, str) or len(image) > 8 * 1024 * 1024 or not image.startswith(('data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,')):
                            raise ValueError('截图数据无效')
                        try: base64.b64decode(image.split(',', 1)[1], validate=True)
                        except (ValueError, TypeError): raise ValueError('截图数据无效') from None
                    self._put(db, kind, row['videoId'], row)
            for memory in bundle.get('longMemories', []):
                if not isinstance(memory.get('body'), str) or not isinstance(memory.get('sources'), list): raise ValueError('长期记忆格式无效')
                for source in memory['sources']:
                    if not isinstance(source,dict) or source.get('videoId') != memory['videoId'] or not db.execute("SELECT 1 FROM records WHERE kind='evidence' AND video_id=? AND id=?", (memory['videoId'], source.get('evidenceId'))).fetchone():
                        raise ValueError('长期记忆来源不属于当前视频')
            for node in bundle.get('nodes',[]):
                for kind,key in [('evidence','evidenceIds'),('keyframes','keyframeIds')]:
                    for identifier in node.get(key,[]):
                        if not isinstance(identifier,str) or not db.execute('SELECT 1 FROM records WHERE kind=? AND video_id=? AND id=?',(kind,node['videoId'],identifier)).fetchone():raise ValueError('笔记来源不属于当前视频')
        return {'videos': len(videos)}
