import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from app import NativeBridge
from source_metadata import web_identity, platform_for_url, clean_page_title


class SourceMetadataChecks(unittest.TestCase):
    def test_tracking_or_timestamp_does_not_split_video(self):
        self.assertEqual(web_identity('https://www.youtube.com/watch?v=a&t=20'), web_identity('https://www.youtube.com/watch?v=a&t=50'))
        self.assertNotEqual(web_identity('https://www.youtube.com/watch?v=a'), web_identity('https://www.youtube.com/watch?v=b'))

    def test_platform_is_taken_from_exact_host_not_picker_default(self):
        self.assertEqual(platform_for_url('https://www.bilibili.com/video/BV1/'), 'Bilibili')
        self.assertEqual(platform_for_url('https://www.youtube.com/watch?v=a'), 'YouTube')
        self.assertEqual(platform_for_url('http://127.0.0.1:4567/'), '网页课程')
        self.assertEqual(platform_for_url('https://youtube.com.example.org/'), '网页课程')
        self.assertEqual(clean_page_title('  The solar system - YouTube '), 'The solar system')

    def test_title_update_does_not_switch_source_or_accept_stale_page(self):
        owner = SimpleNamespace(web_entry='current', current_source={'id':'same-video','url':'vma-web://lesson/current','title':'youtube.com'}, web_sources={'current':{'address':'https://www.youtube.com/watch?v=a'}}, notify=Mock())
        NativeBridge.web_title_changed(owner, 'Other video', 'https://www.youtube.com/watch?v=b')
        owner.notify.assert_not_called()
        NativeBridge.web_title_changed(owner, 'Solar system - YouTube', 'https://www.youtube.com/watch?v=a')
        self.assertEqual(owner.current_source['id'], 'same-video')
        self.assertEqual(owner.current_source['title'], 'Solar system')
        owner.notify.assert_called_once()

    def test_next_video_does_not_overwrite_previous_video_address(self):
        original = 'https://www.youtube.com/watch?v=first'
        owner = SimpleNamespace(web_entry='first-alias', web_sources={'first-alias':{'address':original,'browser':'in-app'}}, current_source={'url':'vma-web://lesson/first-alias'}, capture=Mock(), capture_web=Mock(), notify=Mock())
        with TemporaryDirectory() as folder, patch('app.STATE', Path(folder)), patch('app.QTimer.singleShot'):
            NativeBridge.web_navigated(owner, 'https://www.youtube.com/watch?v=second')
        self.assertEqual(owner.web_sources['first-alias']['address'], original)
        self.assertNotEqual(owner.web_entry, 'first-alias')


if __name__ == '__main__': unittest.main()
