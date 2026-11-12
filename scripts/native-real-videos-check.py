"""两段真实B站原媒体：原生解码→原图→系统OCR→摘要→长期记忆→同视频问答。
只读取已下载的测试课程和用户已配置的OpenCode Go，会消耗AI额度。
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
root=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(root/'desktop'))
os.environ['QT_QPA_PLATFORM']='offscreen'
temporary=tempfile.TemporaryDirectory(prefix='vidence-real-native-'); os.environ['VMA_STATE_DIR']=temporary.name
from PySide6.QtWidgets import QApplication,QMainWindow
from PySide6.QtTest import QTest
from native_media import NativeBridge
from native_store import NativeStore
from native_ui import NativeSidebar
from native_agent import NativeAgent
from local_models import LocalModels
app=QApplication([]); window=QMainWindow(); bridge=NativeBridge(window); bridge.audio.setMuted(True)
store=NativeStore(Path(temporary.name)/'learning.sqlite'); store.set_setting('appUpdates',{'auto':False}); store.set_setting('ocrEnabled',True); store.set_setting('resourceTier','low')
store.set_setting('assistant',{'route':'local-agent','backend':'opencode-go','model':'deepseek-v4.1-flash'})
with patch.object(NativeSidebar,'bootstrap'):sidebar=NativeSidebar(window,bridge,store,LocalModels(root,Path(temporary.name)))
window.setCentralWidget(sidebar); window.resize(1280,800); window.show()
token=(root/'.local-agent/token').read_text(encoding='utf8').strip()
report={'scope':'two-real-media-native-pipeline','realModel':True,'model':'deepseek-v4.1-flash','cases':[]}
(root/'artifacts/native-real-videos.json').write_text(json.dumps(report),encoding='utf8')
def wait(check,seconds=15):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        QTest.qWait(50)
        if check():return
    raise AssertionError('native stage timeout')
try:
    for code,position,term,other in [('BV1G7jJ6nEbV',324,'65','Excel'),('BV1ge4y1V7RS',120,'Ctrl','a²')]:
        media=root/'artifacts/keyframe-audit'/code/'video.mp4'; assert media.is_file()
        source=json.loads(bridge.load_video(media)); sidebar.select_source(source); bridge.presentation.attach()
        wait(lambda:bridge.latest_frame.isValid()); bridge.player.pause(); bridge.player.setPosition(position*1000)
        wait(lambda:abs(bridge.latest_frame_time-position)<.8)
        sidebar.recorder.start(source['id']); sidebar.recorder.sample(True)
        wait(lambda:bool(store.rows('evidence',source['id'])),30); sidebar.recorder.stop()
        frame=store.rows('keyframes',source['id'])[-1]; evidence=store.rows('evidence',source['id'])
        print(code,'captured',frame['width'],frame['height'],'OCR characters',len(evidence[0]['text']),flush=True)
        original=base64.b64decode(frame['imageDataUrl'].split(',',1)[1]); saved=root/'artifacts'/f'native-capture-{code}.jpg'; saved.write_bytes(original)
        agent=NativeAgent(store,token,status=lambda text:print(code,text,flush=True)); memory=agent.build_memory(source['id'])
        answer=NativeAgent(store,token).ask(source['id'],'根据本视频的长期记忆，概括已记录的知识、公式或操作步骤。只使用记录过的内容；不要用其他视频或常识补充。')
        assert answer['memoryContext']['videoId']==source['id'] and answer['memoryContext']['revision']==memory['revision']
        assert all(value['videoId']==source['id'] for value in memory['sources'])
        assert not store.search(source['id'],other)
        case={'bvid':code,'videoId':source['id'],'width':frame['width'],'height':frame['height'],'mediaTime':frame['time'],'imageSha256':hashlib.sha256(original).hexdigest(),'ocr':evidence[0]['text'],'memory':memory['body'],'answer':answer['answer'],'memoryContext':answer['memoryContext'],'usage':answer['usage'],'passed':True}
        report['cases'].append(case); (root/'artifacts/native-real-videos.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    assert len({value['videoId'] for value in report['cases']})==2
    assert len(store.videos())==2
    for case in report['cases']:assert len(store.rows('chats',case['videoId']))==1
    report['passed']=True
finally:
    sidebar.shutdown(); bridge.player.stop(); bridge.capture.stop(); bridge.presentation.timer.stop()
    if bridge.presentation.player:bridge.presentation.player.hide()
    window.hide(); temporary.cleanup()
    (root/'artifacts/native-real-videos.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'passed':report.get('passed',False),'videos':len(report['cases'])}),flush=True)
