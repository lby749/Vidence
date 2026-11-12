import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PySide6.QtWidgets import QApplication
from launcher import Launcher, ROOT, system_library_paths


class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])

    def test_native_app_launch_needs_no_webview_extension_or_system_tools(self):
        window=Launcher()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'Vidence.exe').write_bytes(b'test-not-executable')
            with patch('launcher.APP_DIR',root),patch('launcher.focus_app',return_value=False),patch('launcher.QProcess.startDetached',return_value=(True,123)) as start,patch('shutil.which',side_effect=AssertionError('must not search developer tools')):
                window.open_app()
                self.assertEqual(start.call_args.args,(str(root/'Vidence.exe'),[],str(root)))

    def test_incomplete_desktop_package_does_not_launch_other_programs(self):
        window=Launcher()
        with tempfile.TemporaryDirectory() as directory,patch('launcher.APP_DIR',Path(directory)),patch('launcher.focus_app',return_value=False),patch('launcher.QProcess.startDetached') as start:
            window.open_app(); start.assert_not_called(); self.assertIn('不完整',window.status.text())

    @unittest.skipUnless(os.name=='nt','Windows DLL search path behavior')
    def test_external_program_library_path_is_restored_after_failure(self):
        original_path=str(ROOT)+os.pathsep+r'C:\Windows\System32'
        with patch.dict(os.environ,PATH=original_path),patch('launcher.FROZEN',True),patch('ctypes.windll.kernel32.SetDllDirectoryW') as set_path:
            with self.assertRaises(ValueError),system_library_paths():
                self.assertIsNone(set_path.call_args.args[0]); self.assertEqual(os.environ['PATH'],r'C:\Windows\System32'); raise ValueError('failed launch')
            self.assertEqual(os.environ['PATH'],original_path); self.assertEqual(set_path.call_args.args,(str(ROOT),))


if __name__=='__main__':unittest.main()
