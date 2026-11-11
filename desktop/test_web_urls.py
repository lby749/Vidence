import unittest
from app import normalize_web_url

class WebAddressTests(unittest.TestCase):
    def test_course_addresses(self):
        self.assertEqual(normalize_web_url('youtube.com/watch?v=abc'), 'https://youtube.com/watch?v=abc')
        self.assertEqual(normalize_web_url(' http://127.0.0.1:8123/course '), 'http://127.0.0.1:8123/course')
        self.assertEqual(normalize_web_url('https://example.com/#/lesson/2'), 'https://example.com/#/lesson/2')

    def test_reject_non_web_and_credentials(self):
        for value in ['', 'javascript:alert(1)', 'file:///C:/Windows/a.exe', 'chrome://settings', 'https://user:password@example.com/', 'https://example.com/\n--app=x']:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): normalize_web_url(value)

if __name__ == '__main__': unittest.main()
