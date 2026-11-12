from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock,patch
from PySide6.QtCore import QObject,Qt
from PySide6.QtGui import QImage,QPainter
from PySide6.QtWidgets import QApplication
from native_store import NativeStore
from native_recording import Recorder


class NativeRecordingChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.store=NativeStore(Path(self.temporary.name)/'test.sqlite'); self.store.save_video({'id':'math','title':'同名课程'})
        self.bridge=QObject(); self.bridge.mode='window'; self.bridge.current_source={'id':'math'}; self.bridge.target_window=17
        self.bridge.capture_error=self.bridge.media_error=''; self.bridge.latest_frame_stamp=time.time_ns()
        self.recorder=Recorder(self.bridge,self.store); self.addCleanup(self.recorder.stop)

    def test_changed_source_or_window_title_stops_before_saving_or_ocr(self):
        messages=[]; self.recorder.problem.connect(messages.append); self.recorder.start('math')
        self.bridge.current_source={'id':'another-video'}; self.recorder.sample(True)
        self.assertIsNone(self.recorder.video_id); self.assertEqual(self.store.rows('keyframes','math'),[])
        self.bridge.current_source={'id':'math','captureTitle':'Math lesson'}; self.recorder.start('math')
        with patch('native_recording.window_title',return_value='Another lesson'):self.recorder.sample(True)
        self.assertIsNone(self.recorder.video_id); self.assertEqual(len(messages),2)

    def test_ocr_can_continue_without_new_saved_keyframes(self):
        self.store.set_setting('frameBudget',1); self.store.set_setting('ocrEnabled',True)
        self.store.put('keyframes','math',{'id':'existing','time':12})
        image=QImage(320,180,QImage.Format.Format_RGB32); image.fill(Qt.GlobalColor.white); painter=QPainter(image); painter.fillRect(10,10,150,100,Qt.GlobalColor.black); painter.end()
        frame=Mock(); frame.isValid.return_value=True; frame.toImage.return_value=image; self.bridge.latest_frame=frame
        calls=[]; self.recorder.ocr_requested.connect(lambda *arguments:calls.append(arguments)); self.recorder.start('math'); self.recorder.sample()
        self.assertEqual(len(calls),1); self.assertEqual(calls[0][0],'math'); self.assertEqual(len(self.store.rows('keyframes','math')),1)
        self.assertGreaterEqual(calls[0][3],12)

    def test_color_changes_are_not_lost_when_max_rgb_is_equal(self):
        red=QImage(320,180,QImage.Format.Format_RGB32); red.fill(Qt.GlobalColor.red)
        blue=QImage(320,180,QImage.Format.Format_RGB32); blue.fill(Qt.GlobalColor.blue)
        mean,cells=Recorder.difference(Recorder.signature(red),Recorder.signature(blue))
        self.assertGreater(mean,.1); self.assertGreater(cells,6)


if __name__=='__main__':unittest.main()
