from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from PySide6.QtCore import QRect
from PySide6.QtGui import QImage, QColor
from app import NativeBridge
from presentation import Presentation


class CaptureChecks(unittest.TestCase):
    def test_video_callbacks_only_cache_frames_without_encoding_or_throttling(self):
        owner = SimpleNamespace(mode='local', player=Mock())
        frames = [Mock() for _ in range(60)]
        for index, frame in enumerate(frames):
            frame.isValid.return_value = True; frame.startTime.return_value = index * 16667
        with patch('native_media.QVideoFrame', side_effect=lambda frame: frame):
            for frame in frames: NativeBridge.accept_frame(owner, frame)
        self.assertIs(owner.latest_frame, frames[-1])
        for frame in frames: frame.toImage.assert_not_called()
        self.assertAlmostEqual(owner.latest_frame_time, 59 * 16667 / 1000000)

    def test_preview_is_encoded_on_demand_and_same_frame_is_reused(self):
        image = QImage(64, 64, QImage.Format.Format_RGB32); image.fill(QColor('#2288ff'))
        frame = Mock(); frame.isValid.return_value = True; frame.toImage.return_value = image
        owner = SimpleNamespace(latest_frame=frame, latest_frame_stamp=1234567890, preview_frame=(0, b''))
        for _ in range(3): NativeBridge.encode_preview(owner)
        frame.toImage.assert_called_once()
        self.assertEqual(owner.preview_frame[0], 1234567890)
        decoded = QImage.fromData(owner.preview_frame[1])
        self.assertEqual(decoded.width(), 64)
        self.assertGreater(decoded.pixelColor(10, 10).blue(), 200)

    def test_notify_updates_the_existing_page(self):
        page = Mock()
        NativeBridge.notify(SimpleNamespace(page=page), 'desktop:presentation', {'attached': True})
        script = page.runJavaScript.call_args.args[0]
        self.assertIn('window.dispatchEvent(new CustomEvent(', script)
        self.assertIn('"attached": true', script)

    def test_same_web_window_does_not_restart_capture(self):
        web = Mock(); web.isVisible.return_value = True; web.winId.return_value = 17; web.windowTitle.return_value = 'owned'
        capture = Mock(); capture.isActive.return_value = True
        owner = SimpleNamespace(web_window=web, capture=capture, captured_web_handle=17, mode='window', player=Mock(), web_attach_pending=False)
        candidate = Mock(); candidate.description.return_value = 'owned'
        with patch('native_media.QWindowCapture.capturableWindows', return_value=[candidate]):
            for _ in range(3): NativeBridge.capture_web(owner)
        capture.stop.assert_not_called(); capture.start.assert_not_called()
        self.assertFalse(owner.player.pause.called)

    def test_follow_unchanged_geometry_does_not_repaint_window(self):
        web = Mock(); web.winId.return_value = 17; web.frameGeometry.return_value = QRect(100,100,1100,720); web.isMinimized.return_value = False
        window = Mock(); window.geometry.return_value = QRect(1207,100,380,720); window.isVisible.return_value = True
        screen = Mock(); screen.availableGeometry.return_value = QRect(0,0,2560,1440)
        owner = SimpleNamespace(target=17, owner_window=web, player=None, bridge=SimpleNamespace(web_window=web), window=window, collapsed=False)
        with patch('presentation.QApplication.screenAt', return_value=screen):
            for _ in range(3): Presentation.follow(owner)
        window.setGeometry.assert_not_called(); window.setVisible.assert_not_called()


if __name__ == '__main__': unittest.main()
