"""复现真实端口上的配对不匹配，再经原生设置连接已有OpenCode Go；不调用模型生成。"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
root=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(root/'desktop')); os.environ['QT_QPA_PLATFORM']='offscreen'
from PySide6.QtWidgets import QApplication,QMainWindow
from PySide6.QtTest import QTest
from native_media import NativeBridge
from native_ui import NativeSidebar
from native_store import NativeStore
from local_models import LocalModels

app=QApplication([])
with tempfile.TemporaryDirectory(prefix='vidence-pairing-') as directory:
    state=Path(directory); store=NativeStore(state/'test.sqlite'); store.set_setting('appUpdates',{'auto':False})
    window=QMainWindow()
    with patch('native_media.STATE',state):bridge=NativeBridge(window)
    wrong=state/'wrong-token'; wrong.write_text('0'*64)
    with patch.dict(os.environ,VMA_PAIRING_FILE=str(wrong)):
        result=json.loads(bridge.bootstrap()); assert result.get('existingBridge') and 'token' not in result
    with patch.object(NativeSidebar,'bootstrap'):sidebar=NativeSidebar(window,bridge,store,LocalModels(root,state))
    window.setCentralWidget(sidebar); window.resize(450,860); window.show()
    token=(root/'.local-agent/token').read_text(encoding='utf8').strip(); sidebar.bridge_token.setText(token); sidebar.connect_existing()
    def wait(check):
        until=time.monotonic()+15
        while time.monotonic()<until:
            QTest.qWait(50)
            if check():return
        raise AssertionError('Pairing UI timeout: '+sidebar.status.text()+'; models='+str(sidebar.model.count())+'; backend='+str(sidebar.backend.currentData()))
    wait(lambda:sidebar.token==token); assert store.setting('bridgeToken')==token
    sidebar.discover(); wait(lambda:sidebar.model.count()>1)
    identifiers=[sidebar.model.itemData(index) for index in range(sidebar.model.count())]
    assert 'deepseek-v4.1-flash' in identifiers
    assert token not in json.dumps(store.export([]))
    report={'passed':True,'realLocalBridge':True,'wrongPairingDetected':True,'nativeExistingConnection':True,'openCodeGoModelCount':sidebar.model.count(),'requestedVisionModelAvailable':True,'tokenExcludedFromExports':True,'modelGenerationCalls':0}
    (root/'artifacts/native-pairing-check.json').write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report),flush=True)
    sidebar.shutdown(); bridge.player.stop(); bridge.capture.stop(); bridge.presentation.timer.stop(); window.hide()
