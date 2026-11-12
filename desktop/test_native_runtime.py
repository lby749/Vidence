import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from local_models import LocalModels


class NativeRuntimeChecks(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.models=LocalModels(Path(__file__).resolve().parents[1],Path(self.temporary.name))

    def spec(self,data):return {'name':'runtime.zip','url':'https://example.invalid/pinned-runtime.zip','bytes':len(data),'digest':'sha256:'+hashlib.sha256(data).hexdigest()}

    def archive(self,path='llama-server.exe'):
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:archive.writestr(path,b'fixture-not-executable')
        return buffer.getvalue()

    def test_chosen_runtime_is_hash_checked_and_second_install_uses_marker(self):
        data=self.archive(); spec=self.spec(data); self.models.runtime_spec={'platforms':{'windows-x86_64-cpu':spec,'windows-x86_64-vulkan':spec}}
        with patch('local_models.platform.system',return_value='Windows'),patch('local_models.platform.machine',return_value='AMD64'),patch('local_models.urllib.request.urlopen',side_effect=lambda *args,**kwargs:io.BytesIO(data)) as fetch:
            self.models.download_runtime(lambda loaded,total:None)
            self.models.download_runtime(lambda loaded,total:None)
            self.assertEqual(fetch.call_count,2)
        for backend in ('cpu','vulkan'):self.assertEqual((self.models.runtime/backend/'verified-archive.sha256').read_text(),spec['digest'])

    def test_bad_hash_or_zip_escape_never_marks_runtime_ready(self):
        for escape in (False,True):
            data=self.archive('../outside.exe' if escape else 'llama-server.exe'); spec=self.spec(data)
            if not escape:spec['digest']='sha256:'+'0'*64
            self.models.runtime_spec={'platforms':{'windows-x86_64-cpu':spec}}
            with patch('local_models.platform.system',return_value='Windows'),patch('local_models.platform.machine',return_value='AMD64'),patch('local_models.urllib.request.urlopen',side_effect=lambda *args,**kwargs:io.BytesIO(data)):
                with self.assertRaises(ValueError):self.models.download_runtime(lambda loaded,total:None)
            self.assertFalse((self.models.runtime/'cpu/verified-archive.sha256').exists())
            self.assertFalse((self.models.runtime/'outside.exe').exists())


if __name__=='__main__':unittest.main()
