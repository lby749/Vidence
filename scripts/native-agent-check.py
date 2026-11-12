"""原生问答真实模型对照，使用已核验的原媒体画面；会消耗AI额度。"""
import base64
import json
from pathlib import Path
import sys
import tempfile
root=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(root/'desktop'))
from native_store import NativeStore
from native_agent import NativeAgent

token=(root/'.local-agent/token').read_text(encoding='utf8').strip()
question='只根据本次实际读取的图片，描述主要图示，并逐字写出右侧等式或表格前两行的文字。没有图片就说明无法读取，不用常识猜测。请引用对应画面。'
report={'realModel':True,'model':'deepseek-v4.1-flash','scope':'native-agent-original-pixels-not-live-capture','captionsProvided':False,'cases':[]}
for name,allowed,file in [('math-image',True,'artifacts/bili-actual-keyframe.jpg'),('no-image',False,'artifacts/bili-actual-keyframe.jpg'),('swapped-excel-image',True,'artifacts/keyframe-audit/BV1ge4y1V7RS/full/68.jpg')]:
    with tempfile.TemporaryDirectory(prefix='vidence-native-agent-') as directory:
        store=NativeStore(Path(directory)/'test.sqlite'); store.save_video({'id':'pixel-only','title':'测试片段'})
        store.set_setting('assistant',{'route':'local-agent','backend':'opencode-go','model':report['model']}); store.set_setting('allowVisionUpload',True)
        store.put('keyframes','pixel-only',{'id':'pixel-frame','time':324,'imageDataUrl':'data:image/jpeg;base64,'+base64.b64encode((root/file).read_bytes()).decode()})
        answer=NativeAgent(store,token,status=lambda text:print(name,text,flush=True)).ask('pixel-only',question,allowed)
        text=answer['answer']
        passed=('65' in text and '13' in text and answer['images']==1 and len(answer['frames'])==1) if name=='math-image' else (answer['images']==0 and '65' not in text and '红楼梦' not in text) if name=='no-image' else ('红楼梦' in text and '西游记' in text and '65' not in text and answer['images']==1)
        report['cases'].append(dict(name=name,passed=passed,**answer)); (root/'artifacts/native-agent-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({'case':name,'passed':passed,'images':answer['images']},ensure_ascii=False),flush=True)
        assert passed,name
report['passed']=True; (root/'artifacts/native-agent-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
