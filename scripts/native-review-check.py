"""真实原图的原生筛选链路检查；会调用用户配置的OpenCode Go并消耗额度。"""
import base64
import json
from pathlib import Path
import sys
import tempfile
root=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(root/'desktop'))
from native_agent import NativeAgent
from native_store import NativeStore

report={'scope':'native-review-three-original-media-frames-not-full-recall','realModel':True,'cases':[]}
with tempfile.TemporaryDirectory(prefix='vidence-native-review-') as directory:
    store=NativeStore(Path(directory)/'test.sqlite'); store.set_setting('allowVisionUpload',True); store.set_setting('assistant',{'route':'local-agent','backend':'opencode-go','model':'deepseek-v4.1-flash'})
    store.save_video({'id':'math','title':'测试片段'}); store.save_video({'id':'excel','title':'测试片段'})
    inputs=[('math','speaker','artifacts/keyframe-audit/BV1G7jJ6nEbV/full/2.jpg',5,'speaker'),('math','knowledge','artifacts/native-capture-BV1G7jJ6nEbV.jpg',323.966688,'knowledge'),('excel','knowledge','artifacts/native-capture-BV1ge4y1V7RS.jpg',119.99,'knowledge')]
    for video,identifier,file,stamp,expected in inputs:store.put('keyframes',video,{'id':identifier,'time':stamp,'imageDataUrl':'data:image/jpeg;base64,'+base64.b64encode((root/file).read_bytes()).decode()})
    token=(root/'.local-agent/token').read_text(encoding='utf8').strip()
    for video in ('math','excel'):
        agent=NativeAgent(store,token,status=lambda text:print(text,flush=True)); count=agent.review_frames(video)
        for _,identifier,file,stamp,expected in [item for item in inputs if item[0]==video]:
            frame=store.get('keyframes',video,identifier); review=frame.get('review',{}); passed=review.get('kind')==expected
            report['cases'].append({'videoId':video,'id':identifier,'review':review,'expected':expected,'passed':passed})
            assert passed,review
        assert count==len([item for item in inputs if item[0]==video])
    report['passed']=True
(root/'artifacts/native-review-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8'); print(json.dumps({'passed':True,'frames':len(report['cases'])}),flush=True)
