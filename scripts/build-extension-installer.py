"""Compile a native WinForms EXE with the exact standalone extension ZIP embedded."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
archive = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
assert sys.platform == 'win32' and root in output.parents and not output.exists()
with archive.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
assert archive.with_suffix('.zip.sha256').read_text(encoding='utf8').split()[0] == digest
version = json.loads((root / 'package.json').read_text(encoding='utf8'))['version']
assert re.fullmatch(r'\d+\.\d+\.\d+', version)
with zipfile.ZipFile(archive) as package:
    manifest = json.loads(package.read('manifest.json'))
    assert manifest['version'] == version and manifest['name'] == 'Vidence'
work = root / '.desktop-build/extension-installer'
work.mkdir(parents=True, exist_ok=True)
metadata = work / 'BuildInfo.cs'
metadata.write_text(f'''using System.Reflection;
[assembly: AssemblyTitle("Vidence Browser Extension Setup")]
[assembly: AssemblyProduct("Vidence")]
[assembly: AssemblyCopyright("MIT License")]
[assembly: AssemblyVersion("{version}.0")]
[assembly: AssemblyFileVersion("{version}.0")]
internal static class BuildInfo {{ internal const string Version = "{version}"; internal const string PayloadSha256 = "{digest}"; }}
''', encoding='utf8')
manifest_file = work / 'app.manifest'
manifest_file.write_text('''<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>
<dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application></compatibility>
<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware></windowsSettings></application>
</assembly>''', encoding='utf8')
framework = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319'
output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([str(framework / 'csc.exe'), '/nologo', '/utf8output', '/codepage:65001', '/target:winexe', '/platform:anycpu', '/optimize+',
                '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll',
                '/reference:System.IO.Compression.FileSystem.dll', '/reference:System.Web.Extensions.dll',
                f'/win32icon:{root / "public/brand/app.ico"}', f'/win32manifest:{manifest_file}', f'/resource:{archive},Vidence.Extension.zip',
                f'/out:{output}', str(root / 'installer/BrowserExtensionSetup.cs'), str(metadata)], check=True, cwd=root)
with output.open('rb') as source:
    exe_digest = hashlib.file_digest(source, 'sha256').hexdigest()
output.with_suffix('.exe.sha256').write_text(f'{exe_digest}  {output.name}\n', encoding='utf8')
print(json.dumps({'exe': str(output), 'bytes': output.stat().st_size, 'sha256': exe_digest, 'payloadSha256': digest, 'bundledBrowser': False, 'bundledPythonOrNode': False}))
