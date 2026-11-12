"""Explicit acceptance entry point; runs only with --journey and isolated temp data.

The cloud runner supplies a real, local vision-model endpoint. No canned AI replies.
Generated teaching videos are fixtures, never described as actual platform courses.
"""
import json
import os
from pathlib import Path
import tempfile
import time
import traceback
from PySide6.QtCore import Qt,QTimer
from PySide6.QtTest import QTest
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import QApplication,QFileDialog,QPushButton,QLineEdit
from app_version import VERSION
from native_store import NativeStore
from native_agent import NativeAgent
from ui_locale import ui_text


class Journey:
    def __init__(self,state,plan_file):
        self.state=state.resolve(); self.plan=json.loads(Path(plan_file).read_text(encoding='utf8'))
        assert os.environ.get('VMA_STATE_DIR') and self.state.is_relative_to(Path(tempfile.gettempdir()).resolve()),'Acceptance data must be in an explicit temporary directory'
        self.report=Path(self.plan['report']); self.report.parent.mkdir(parents=True,exist_ok=True)
        self.result={'version':VERSION,'scope':'frozen-native-user-journey-generated-teaching-media','phase':self.plan['phase'],'realModel':True,'model':self.plan['model'],'steps':[],'passed':False}
        self.config={'route':'api','protocol':'openai','baseUrl':self.plan['baseUrl'],'model':self.plan['model'],'apiKey':'journey-loopback-only'}
        assert self.config['baseUrl'].startswith('http://127.0.0.1:')
        if os.name=='nt':
            for name in ('segoeui.ttf','msyh.ttc'):QFontDatabase.addApplicationFont(str(Path(os.environ['WINDIR'])/'Fonts'/name))
        if self.plan['phase']=='record':
            store=NativeStore(state/'learning.sqlite')
            for key,value in {'assistant':self.config,'appUpdates':{'auto':False},'uiLanguage':'en','answerLanguage':'English','allowVisionUpload':True,'ocrEnabled':True,'ocrLanguage':'en-US','resourceTier':'low'}.items():store.set_setting(key,value)

    def save(self):self.report.write_text(json.dumps(self.result,ensure_ascii=False,indent=2),encoding='utf8')

    def wait(self,condition,seconds=150):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            QTest.qWait(50)
            if condition():return
        raise AssertionError('Journey timed out: '+self.sidebar.status.text())

    def step(self,name,action):
        start=time.monotonic(); value=action()
        self.result['steps'].append({'name':name,'passed':True,'seconds':round(time.monotonic()-start,2),'details':value});self.save()

    def click(self,text,tab=None):
        if tab is not None:self.sidebar.tabs.setCurrentIndex(tab)
        QApplication.processEvents(); target=ui_text(text,'en')
        candidates=[b for b in self.sidebar.findChildren(QPushButton) if b.text()==target and b.isVisible()]
        assert len(candidates)==1,(text,len(candidates))
        QTest.mouseClick(candidates[0],Qt.MouseButton.LeftButton)

    def file_dialog(self,action,path):
        errors=[]
        def choose():
            dialog=QApplication.activeModalWidget()
            if not isinstance(dialog,QFileDialog):errors.append('Expected the actual Qt file chooser');return
            edit=dialog.findChild(QLineEdit,'fileNameEdit')
            if edit is None:errors.append('File chooser input missing');dialog.reject();return
            edit.setText(str(path));dialog.accept()
            if dialog.isVisible():errors.append('File chooser did not accept the requested file');dialog.reject()
        def timeout():
            errors.append('File chooser timed out')
            dialog=QApplication.activeModalWidget()
            if dialog:dialog.reject()
        timer=QTimer();timer.setSingleShot(True);timer.timeout.connect(timeout);timer.start(10000)
        try:QTimer.singleShot(200,choose);action()
        finally:timer.stop()
        assert not errors,errors

    def ask(self,question,images=False):
        identifier=self.sidebar.video_id; previous=len(self.store.rows('chats',identifier))
        self.sidebar.tabs.setCurrentIndex(0);self.sidebar.allow_images.setChecked(images);self.sidebar.question.setPlainText(question)
        QTest.mouseClick(self.sidebar.send,Qt.MouseButton.LeftButton)
        self.wait(lambda:self.sidebar.ai_job is None and len(self.store.rows('chats',identifier))>previous)
        return self.store.rows('chats',identifier)[-1]

    def record(self,index):
        sidebar=self.sidebar; path=Path(self.plan['media'][index]).resolve()
        self.file_dialog(sidebar.open_local,path)
        self.wait(lambda:self.bridge.latest_frame.isValid(),20);self.bridge.player.pause()
        identifier=sidebar.video_id;assert identifier and identifier not in self.ids
        sidebar.record.click();sidebar.capture.click()
        self.wait(lambda:bool(self.store.rows('evidence',identifier)) and not sidebar.recorder.ocr_busy,35)
        sidebar.record.click();assert self.store.rows('keyframes',identifier)
        text=' '.join(row['text'] for row in self.store.rows('evidence',identifier));number=('37','82')[index]
        assert number in text,text
        self.click('读取原图并筛选',1)
        self.wait(lambda:sidebar.ai_job is None and all(row.get('review') for row in self.store.rows('keyframes',identifier)))
        assert all(row['review']['kind']=='knowledge' for row in self.store.rows('keyframes',identifier))
        self.click('生成记忆',2);self.wait(lambda:sidebar.ai_job is None and self.store.memory(identifier) is not None)
        memory=self.store.memory(identifier);assert number in memory['body'],memory['body']
        answer=self.ask('According to this video\'s saved long-term memory, what sample measurement or population was recorded? Include its number. Do not infer other lessons.')
        assert number in answer['answer'],answer['answer']
        assert answer['memoryContext']['videoId']==identifier and answer['memoryContext']['revision']==memory['revision']
        assert ('82' if index==0 else '37') not in answer['answer'],answer['answer']
        assert all(row['videoId']==identifier for row in memory['sources'])
        if index==0:
            visual=self.ask('Read the original frame with get_timeline and get_frame. What is the large geometric shape and its color?',True)
            assert visual['images']>0 and sidebar.references.count()>0 and all(row['videoId']==identifier for row in visual['frames'])
        sidebar.question.setPlainText('DRAFT_'+str(index));self.ids.append(identifier)
        self.window.grab().save(str(self.report.parent/('journey-'+str(index)+'.png')))
        return {'videoId':identifier,'ocr':text,'memory':memory['body'],'answer':answer['answer'],'memoryContext':answer['memoryContext'],'imagesSaved':len(self.store.rows('keyframes',identifier))}

    def isolation(self):
        for index,identifier in enumerate(self.ids):
            self.sidebar.select_source(self.store.video(identifier))
            assert self.sidebar.question.toPlainText()=='DRAFT_'+str(index)
            assert self.store.search(identifier,('37','82')[index])
            assert not self.store.search(identifier,('82','37')[index])
        self.sidebar.tabs.setCurrentIndex(3);self.sidebar.refresh_library()
        for index in range(self.sidebar.library.count()):
            item=self.sidebar.library.item(index)
            item.setCheckState(Qt.CheckState.Checked if item.data(Qt.ItemDataRole.UserRole)['id']==self.ids[0] else Qt.CheckState.Unchecked)
        counts={identifier:len(self.store.rows('chats',identifier)) for identifier in self.ids}
        output=self.state/'selected-export.json';self.file_dialog(self.sidebar.export_data,output)
        bundle=json.loads(output.read_text(encoding='utf8'));assert [row['id'] for row in bundle['videos']]==self.ids[:1]
        assert 'journey-loopback-only' not in output.read_text(encoding='utf8') and 'assistant' not in bundle
        imported=NativeStore(self.state/'import.sqlite');imported.import_bundle(bundle)
        assert imported.memory(self.ids[0])['body']==self.store.memory(self.ids[0])['body'] and imported.video(self.ids[1]) is None
        self.file_dialog(self.sidebar.import_data,output)
        assert len(self.store.videos())==2 and all(len(self.store.rows('chats',identifier))==counts[identifier] for identifier in self.ids)
        (self.state/'journey-ids.json').write_text(json.dumps(self.ids))
        return {'chatAndDraftIsolation':True,'memoryAndSearchIsolation':True,'selectiveExport':True,'secretsExcluded':True,'importIntoFreshDatabase':True,'uiImportNoDuplicateChat':True}

    def vision_controls(self):
        results=[]
        # Same neutral question and IDs. Only pixel bytes/permission differ.
        for index,(source,allowed) in enumerate([(self.ids[0],True),(self.ids[0],False),(self.ids[1],True)]):
            store=NativeStore(self.state/f'pixels-{index}.sqlite');store.save_video({'id':'pixels','title':'Image control'})
            store.set_setting('assistant',self.config);store.set_setting('allowVisionUpload',True);store.set_setting('answerLanguage','English')
            frame=dict(self.store.rows('keyframes',source)[0],id='original',videoId='pixels');frame.pop('review',None);store.put('keyframes','pixels',frame)
            answer=NativeAgent(store,'').ask('pixels','Use get_timeline and get_frame to inspect the original pixels. Name the large colored geometric shape. If you cannot read the original image, say UNAVAILABLE. Never infer it from text or filenames.',allowed)
            text=answer['answer'].lower()
            if index==0:assert 'red' in text and ('rectang' in text or 'square' in text) and answer['images']==1,answer
            elif index==1:assert answer['images']==0 and 'unavailable' in text and 'red' not in text and 'blue' not in text,answer
            else:assert 'blue' in text and ('circl' in text or 'round' in text) and answer['images']==1,answer
            results.append({'allowed':allowed,'images':answer['images'],'answer':answer['answer'],'references':answer['frames']})
        return results

    def restart(self):
        self.ids=json.loads((self.state/'journey-ids.json').read_text())
        assert len(self.store.videos())==2
        for index,identifier in enumerate(self.ids):
            self.sidebar.select_source(self.store.video(identifier))
            assert self.sidebar.question.toPlainText()=='DRAFT_'+str(index)
            assert self.store.memory(identifier) and self.store.rows('chats',identifier)
            answer=self.ask('From the saved memory of this video only, repeat the recorded sample number.')
            assert ('37','82')[index] in answer['answer'] and ('82','37')[index] not in answer['answer']
            assert answer['memoryContext']['videoId']==identifier
        return {'freshProcess':True,'savedMemoryUsedForNewAnswer':True,'chatAndDraftsRestored':True,'videoIsolationPreserved':True}

    def run(self,window):
        self.window=window;self.sidebar=window.sidebar;self.store=self.sidebar.store;self.bridge=window.native;self.ids=[]
        self.bridge.audio.setMuted(True);self.save()
        try:
            if self.plan['phase']=='record':
                self.step('native API model discovery',lambda:self.discover())
                for index in range(2):self.step('video '+str(index)+' recording OCR memory and chat',lambda index=index:self.record(index))
                self.step('isolation selective export and import',self.isolation)
                self.step('real vision original no-image and swapped-image controls',self.vision_controls)
                self.step('native playback fullscreen and sidebar controls',self.controls)
            else:self.step('restarted application reads and uses persisted learning data',self.restart)
            self.result['passed']=True
        except Exception as error:self.result['error']=str(error)[:2000];self.result['traceback']=traceback.format_exc()[-5000:]
        finally:self.save();window.close();QApplication.exit(0 if self.result['passed'] else 1)

    def discover(self):
        self.sidebar.discover();self.wait(lambda:self.sidebar.ai_job is None and self.sidebar.model.count()>0)
        assert self.sidebar.quick_model.currentData()==self.plan['model'];return {'modelId':self.sidebar.quick_model.currentData()}

    def controls(self):
        player=self.bridge.presentation.player;assert player
        player.fullscreen_button.click();QApplication.processEvents();assert self.window.isFullScreen()
        player.fullscreen_button.click();QApplication.processEvents();assert not self.window.isFullScreen()
        self.sidebar.close_sidebar();QApplication.processEvents();assert self.sidebar.isHidden()
        self.bridge.presentation.toggle_sidebar();QApplication.processEvents();assert self.sidebar.isVisible()
        return {'fullscreenAndExit':True,'trueCloseAndReopen':True}
