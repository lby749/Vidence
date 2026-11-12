"""Native UI + real loopback HTTP transport. Fixtures only; no real API/model calls."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

root=Path(__file__).resolve().parents[1]
os.environ['QT_QPA_PLATFORM']='offscreen'
sys.path.insert(0,str(root/'desktop'))
from PySide6.QtWidgets import QApplication,QMainWindow
from PySide6.QtTest import QTest
from native_ui import NativeSidebar,STYLE
from native_store import NativeStore
from native_media import NativeBridge
from local_models import LocalModels

requests=[]
class Api(BaseHTTPRequestHandler):
    def log_message(self,*_args):pass
    def reply(self,data,status=200):
        self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())
    def do_GET(self):
        requests.append({'path':self.path})
        if self.headers.get('Authorization')!='Bearer fixture-only-key':self.reply({'error':'unauthorized'},401);return
        assert self.path=='/v1/models'
        self.reply({'data':[{'id':'deepseek-v4.1-flash','name':'DeepSeek Flash'},{'id':'chosen-chat','name':'Readable Chat'},{'id':'text-embedding-only'}]})
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append({'path':self.path,'model':body['model']})
        assert self.path=='/v1/chat/completions' and self.headers.get('Authorization')=='Bearer fixture-only-key'
        self.reply({'choices':[{'message':{'role':'assistant','content':'FIXTURE_API_ACK'},'finish_reason':'stop'}],'usage':{'prompt_tokens':3,'completion_tokens':1}})

server=ThreadingHTTPServer(('127.0.0.1',0),Api);threading.Thread(target=server.serve_forever,daemon=True).start()
app=QApplication([]);app.setStyleSheet(STYLE)
def wait_for(check):
    until=time.monotonic()+10
    while time.monotonic()<until:
        QTest.qWait(25)
        if check():return
    raise AssertionError('Native fixture request timed out')

try:
    with tempfile.TemporaryDirectory(prefix='native-api-setup-') as directory:
        state=Path(directory);store=NativeStore(state/'test.sqlite');store.set_setting('appUpdates',{'auto':False})
        window=QMainWindow();window.resize(450,860)
        with patch('native_media.STATE',state):bridge=NativeBridge(window)
        with patch.object(NativeSidebar,'bootstrap'):sidebar=NativeSidebar(window,bridge,store,LocalModels(root,state))
        window.setCentralWidget(sidebar)
        sidebar.route.setCurrentIndex(sidebar.route.findData('api'))
        sidebar.base_url.setText(f'http://127.0.0.1:{server.server_address[1]}/v1/chat/completions')
        sidebar.api_key.setText('fixture-only-key');sidebar.model.setEditText('chosen-chat');sidebar.discover()
        wait_for(lambda:sidebar.ai_job is None and sidebar.model.count()==2)
        assert store.setting('assistant')['model']=='chosen-chat' and sidebar.quick_model.currentData()=='chosen-chat'
        selected=sidebar.quick_model.findData('deepseek-v4.1-flash');sidebar.quick_model.setCurrentIndex(selected);sidebar.quick_model.activated.emit(selected)
        assert store.setting('assistant')['model']=='deepseek-v4.1-flash'
        store.save_video({'id':'api-fixture','title':'Controlled fixture','url':'vma-course://fixture'})
        sidebar.select_source(store.video('api-fixture'));sidebar.question.setPlainText('连接测试');sidebar.send.click()
        wait_for(lambda:sidebar.ai_job is None and bool(store.rows('chats','api-fixture')))
        assert store.rows('chats','api-fixture')[-1]['answer']=='FIXTURE_API_ACK'
        assert requests[-1]=={'path':'/v1/chat/completions','model':'deepseek-v4.1-flash'}
        sidebar.api_key.setText('invalid-fixture-key');sidebar.discover();wait_for(lambda:sidebar.ai_job is None)
        assert '失败' in sidebar.status.text() and 'fixture-only-key' not in sidebar.status.text()
        sidebar.shutdown();window.close();bridge.player.stop();bridge.presentation.timer.stop()
    report={'passed':True,'scope':'offscreen-native-ui-and-loopback-api','realModel':False,'endpointNormalization':True,'chatModelsOnly':True,'modelLabelAndIdSeparate':True,'inlineModelChoiceSaved':True,'actualHttpQuestion':True,'badKeyReported':True}
    (root/'artifacts/native-api-setup-check.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report))
finally:server.shutdown();server.server_close()
