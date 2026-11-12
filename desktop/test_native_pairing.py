import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
from native_media import NativeBridge


class NativePairingChecks(unittest.TestCase):
    def test_other_pairing_is_reported_without_returning_wrong_token_or_starting_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'token'; file.write_text('a'*64)
            error=urllib.error.HTTPError('http://127.0.0.1:8131/health',401,'unauthorized',{},None)
            with patch.dict(os.environ,VMA_PAIRING_FILE=str(file)),patch('native_media.urllib.request.urlopen',side_effect=error),patch('native_media.subprocess.Popen') as spawn:
                value=json.loads(NativeBridge.bootstrap(SimpleNamespace()))
                self.assertTrue(value['existingBridge']); self.assertNotIn('token',value); spawn.assert_not_called()

    def test_healthy_existing_service_is_reused_without_starting_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'token'; file.write_text('a'*64); response=io.BytesIO(b'{}'); response.status=200
            with patch.dict(os.environ,VMA_PAIRING_FILE=str(file)),patch('native_media.urllib.request.urlopen',return_value=response),patch('native_media.subprocess.Popen') as spawn:
                value=json.loads(NativeBridge.bootstrap(SimpleNamespace()))
                self.assertEqual(value['token'],'a'*64); spawn.assert_not_called()

    def test_first_start_waits_until_the_bundled_worker_is_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'token'; response=io.BytesIO(b'{}'); response.status=200
            with patch.dict(os.environ,VMA_PAIRING_FILE=str(file)),patch('native_media.ROOT',Path(directory)),patch('native_media.urllib.request.urlopen',side_effect=[urllib.error.URLError('not started'),response]),patch('native_media.shutil.which',return_value='fixture-node'),patch('native_media.subprocess.Popen') as spawn:
                value=json.loads(NativeBridge.bootstrap(SimpleNamespace()))
                self.assertEqual(value['token'],file.read_text()); spawn.assert_called_once()


if __name__=='__main__':unittest.main()
