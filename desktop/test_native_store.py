import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from native_store import NativeStore


class NativeStoreChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.store = NativeStore(Path(self.temporary.name) / 'learning.sqlite3')
        for identifier in ('math', 'excel'):
            self.store.save_video({'id': identifier, 'title': identifier, 'url': f'vma-local://video/{identifier}'})

    def tearDown(self):
        self.temporary.cleanup()

    def test_same_record_id_and_search_stay_in_their_video(self):
        self.store.put('evidence', 'math', {'id': 'same', 'text': '勾股定理 a²+b²=c²', 'startTime': 10, 'endTime': 20})
        self.store.put('evidence', 'excel', {'id': 'same', 'text': 'Excel 快速填充 Ctrl+E', 'startTime': 10, 'endTime': 20})
        self.assertEqual(self.store.get('evidence', 'math', 'same')['text'], '勾股定理 a²+b²=c²')
        self.assertEqual(self.store.search('math', 'Excel'), [])
        self.assertEqual(len(self.store.search('excel', 'Excel')), 1)
        self.assertEqual(self.store.search('math', '勾股', start=30, end=40), [])
        self.assertEqual(len(self.store.search('math', '勾股', start=10, end=20)), 1)

    def test_memory_rejects_sources_from_another_video(self):
        self.store.put('evidence', 'excel', {'id': 'source', 'text': '表格', 'startTime': 0, 'endTime': 1})
        with self.assertRaises(ValueError):
            self.store.save_memory('math', '错误记忆', [{'videoId': 'excel', 'evidenceId': 'source'}])
        self.assertIsNone(self.store.memory('math'))

    def test_memory_versions_and_locked_memory_survive_reopening(self):
        self.store.save_memory('math', '第一次', [])
        self.store.save_memory('math', '第二次', [], locked=True)
        self.store = NativeStore(self.store.path)
        self.assertEqual(self.store.memory('math')['versions'][0]['body'], '第一次')
        with self.assertRaises(ValueError): self.store.save_memory('math', '模型覆盖', [])
        self.assertEqual(self.store.memory('math')['body'], '第二次')
        self.assertIsNone(self.store.memory('excel'))

    def test_export_import_preserves_scopes_without_settings_or_local_paths(self):
        self.store.put('evidence', 'math', {'id': 'm1', 'text': '数学', 'startTime': 1, 'endTime': 2})
        self.store.save_memory('math', '数学重点', [{'videoId': 'math', 'evidenceId': 'm1'}])
        self.store.set_setting('apiKey', 'private-fixture-key')
        bundle = self.store.export(['math'])
        raw = json.dumps(bundle)
        self.assertNotIn('private-fixture-key', raw)
        self.assertEqual([v['id'] for v in bundle['videos']], ['math'])
        other = NativeStore(Path(self.temporary.name) / 'import.sqlite3')
        other.import_bundle(bundle)
        self.assertEqual(other.memory('math')['body'], '数学重点')
        self.assertIn('m1', [row['id'] for row in other.search('math', '数学')])

    def test_invalid_import_is_atomic(self):
        bundle = {'format': 'vma-export', 'version': 1, 'videos': [{'id': 'new', 'title': 'New'}], 'evidence': [{'id': 'bad', 'videoId': 'missing', 'text': 'x'}], 'nodes': []}
        with self.assertRaises(ValueError): self.store.import_bundle(bundle)
        self.assertIsNone(self.store.video('new'))

    def test_old_frame_review_is_preserved_without_importing_image_consent(self):
        bundle=self.store.export(['math'])
        bundle['keyframes']=[{'id':'frame','videoId':'math','time':10,'imageDataUrl':'data:image/png;base64,aGVsbG8=','knowledge':{'kind':'speaker','title':'讲者','summary':'讲者画面'},'uploadAllowed':True}]
        self.store.import_bundle(bundle)
        frame=self.store.get('keyframes','math','frame')
        self.assertEqual(frame['review']['kind'],'speaker'); self.assertNotIn('uploadAllowed',frame)


if __name__ == '__main__': unittest.main()
