import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from native_store import NativeStore
from native_agent import NativeAgent, NativeTools


class NativeAgentChecks(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = NativeStore(Path(self.temp.name)/'test.sqlite')
        for video in ('math', 'excel'):
            self.store.save_video({'id': video, 'title': video})
            self.store.put('evidence', video, {'id': 'text', 'text': video+' formula', 'startTime': 10, 'endTime': 12})
            self.store.put('keyframes', video, {'id': 'image', 'time': 11, 'imageDataUrl': 'data:image/png;base64,aGVsbG8='})

    def test_tools_enforce_snapshot_video_time_and_per_request_image_consent(self):
        self.store.set_setting('allowVisionUpload', True)
        tools = NativeTools(self.store, 'math', 'formula', True, ['image'], (10, 15))
        self.assertTrue(tools.execute('read_evidence', {'videoId': 'excel', 'evidenceIds': ['text']})['isError'])
        self.store.put('evidence', 'math', {'id': 'later', 'text': 'formula NEW', 'time': 13})
        self.assertTrue(tools.execute('read_evidence', {'evidenceIds': ['later']})['isError'])
        found = tools.execute('search_library', {'query': 'formula'})
        self.assertNotIn('NEW', json.dumps(found)); self.assertNotIn('excel', json.dumps(found))
        result = tools.execute('get_frame', {'frameId': 'image'})
        self.assertEqual(result['content'][1], {'type': 'image', 'mimeType': 'image/png', 'data': 'aGVsbG8='})
        self.assertEqual(tools.read_frames, [{'id': 'image', 'time': 11, 'videoId': 'math'}])
        self.assertTrue(NativeTools(self.store, 'math', '?').execute('get_frame', {'frameId': 'image'})['isError'])
        self.assertTrue(NativeTools(self.store, 'math', '?', True, bounds=(20,30)).execute('get_frame', {'frameId': 'image'})['isError'])
        self.assertTrue(NativeTools(self.store,'math','?',True).execute('get_frame',{'frameId':[]})['isError'])
        self.assertTrue(NativeTools(self.store,'math','?').execute('read_evidence',{'evidenceIds':[{}]})['isError'])

    def test_initial_question_receives_summary_and_own_memory_not_raw_transcript(self):
        self.store.put('nodes', 'math', {'id': 'summary', 'summary': 'MATH SUMMARY', 'evidenceIds': ['text'], 'startTime': 10, 'endTime': 12})
        self.store.save_memory('math', 'MATH MEMORY', [{'videoId': 'math', 'evidenceId': 'text'}])
        self.store.save_memory('excel', 'EXCEL PRIVATE', [{'videoId': 'excel', 'evidenceId': 'text'}])
        prompts = []
        class Agent(NativeAgent):
            def complete(self, prompt, executor=None): prompts.append(prompt); return 'answer'
        answer = Agent(self.store).ask('math', 'explain')
        self.assertEqual(answer['images'], 0)
        self.assertIn('MATH MEMORY', prompts[0]); self.assertIn('MATH SUMMARY', prompts[0])
        self.assertNotIn('math formula', prompts[0]); self.assertNotIn('EXCEL PRIVATE', prompts[0])
        self.assertEqual(len(self.store.rows('chats', 'excel')), 0)

    def test_filtered_frames_require_manual_restore_and_global_permission(self):
        frame = self.store.get('keyframes', 'math', 'image'); frame['review'] = {'kind': 'speaker'}
        self.store.put('keyframes', 'math', frame); self.store.set_setting('allowVisionUpload', True)
        self.assertTrue(NativeTools(self.store, 'math', '?', True).execute('get_frame', {'frameId': 'image'})['isError'])
        frame['manualKeep'] = True; self.store.put('keyframes', 'math', frame)
        self.store.set_setting('allowVisionUpload', False)
        self.assertTrue(NativeTools(self.store, 'math', '?', True).execute('get_frame', {'frameId': 'image'})['isError'])


if __name__ == '__main__': unittest.main()
