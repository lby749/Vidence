import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PySide6.QtWidgets import QApplication
from launcher import Launcher, ROOT, TEXT, prepare_extension, system_library_paths


class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app = QApplication.instance() or QApplication([])

    def test_prebuilt_extension_copies_without_developer_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'release'; source.mkdir()
            manifest = {'manifest_version': 3, 'background': {'service_worker': 'background.js'}, 'side_panel': {'default_path': 'sidepanel.html'}, 'options_ui': {'page': 'library.html'}}
            (source / 'manifest.json').write_text(json.dumps(manifest))
            for name in ('background.js', 'sidepanel.html', 'library.html'): (source / name).write_text('ready')
            with patch('shutil.which', side_effect=AssertionError('must not search for developer tools')):
                destination = prepare_extension(source, root / 'appdata/extension')
            self.assertEqual((destination / 'background.js').read_text(), 'ready')
            manifest['background']['service_worker'] = '../private.txt'
            (source / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): prepare_extension(source, destination)

    def test_missing_webview_uses_bundled_setup_and_retains_local_fallback(self):
        window = Launcher()
        with patch('launcher.focus_app', return_value=False), patch('launcher.webview_available', return_value=False), patch('launcher.QProcess') as process:
            window.open_app()
            program, args = process.return_value.start.call_args.args
            self.assertTrue(program.endswith('MicrosoftEdgeWebview2Setup.exe'))
            self.assertEqual(args, ['/silent', '/install'])
            window.runtime_finished(1)
            self.assertFalse(window.local_button.isHidden())
            self.assertTrue(window.open_button.isEnabled())

    def test_language_and_installer_do_not_claim_silent_extension_install(self):
        self.assertEqual(len({len(text) for text in TEXT.values()}), 1)
        window = Launcher(install=True)
        for locale in TEXT:
            window.language.setCurrentIndex(window.language.findData(locale))
            self.assertEqual(window.steps.text(), TEXT[locale][9])
        self.assertTrue(window.path.isReadOnly())

    def test_external_program_library_path_is_restored_after_failure(self):
        original_path = str(ROOT) + os.pathsep + r'C:\Windows\System32'
        with patch.dict(os.environ, PATH=original_path), patch('launcher.FROZEN', True), patch('ctypes.windll.kernel32.SetDllDirectoryW') as set_path:
            with self.assertRaises(ValueError), system_library_paths():
                self.assertIsNone(set_path.call_args.args[0])
                self.assertEqual(os.environ['PATH'], r'C:\Windows\System32')
                raise ValueError('failed launch')
            self.assertEqual(os.environ['PATH'], original_path)
            self.assertEqual(set_path.call_args.args, (str(ROOT),))


if __name__ == '__main__': unittest.main()
