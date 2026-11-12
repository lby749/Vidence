"""隔离数据的原生UI检查；不打开用户窗口、不调用真实AI、不播放用户课程。"""
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

root=Path(__file__).resolve().parents[1]
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
sys.path.insert(0,str(root/'desktop'))
from PySide6.QtCore import QTimer
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import QApplication, QMainWindow
from native_media import NativeBridge
from native_store import NativeStore
from native_ui import NativeSidebar, STYLE
from local_models import LocalModels

app=QApplication([]); app.setStyleSheet(STYLE)
if os.name=='nt':
    for name in ('segoeui.ttf','msyh.ttc'):QFontDatabase.addApplicationFont(str(Path(os.environ['WINDIR'])/'Fonts'/name))
with tempfile.TemporaryDirectory(prefix='vidence-native-check-') as temp:
    store=NativeStore(Path(temp)/'test.sqlite'); window=QMainWindow(); window.resize(450,860)
    with patch('native_media.STATE',Path(temp)):bridge=NativeBridge(window)
    models=LocalModels(root,Path(temp))
    with patch.object(NativeSidebar,'bootstrap'):
        sidebar=NativeSidebar(window,bridge,store,models); window.setCentralWidget(sidebar); window.show(); app.processEvents()
    for identifier in ('math','excel'):store.save_video({'id':identifier,'title':identifier,'url':'vma-course://lesson/'+identifier})
    store.put('chats','math',{'id':'question','question':'Explain math','answer':'MATH ANSWER','createdAt':1})
    store.put('chats','excel',{'id':'question','question':'Explain spreadsheet','answer':'EXCEL ANSWER','createdAt':1})
    sidebar.select_source(store.video('math')); sidebar.question.setPlainText('MATH DRAFT')
    sidebar.select_source(store.video('excel')); assert 'MATH ANSWER' not in sidebar.chat.toPlainText(); assert 'EXCEL ANSWER' in sidebar.chat.toPlainText()
    sidebar.select_source(store.video('math')); assert sidebar.question.toPlainText()=='MATH DRAFT'; assert 'EXCEL ANSWER' not in sidebar.chat.toPlainText()
    with patch('native_ui.QFileDialog.getOpenFileName',return_value=('','')):sidebar.open_local()
    assert sidebar.video_id=='math' and sidebar.question.toPlainText()=='MATH DRAFT'
    sidebar.bridge_event('desktop:presentation',{'collapsed':True}); assert sidebar.body.isHidden() and not sidebar.rail.isHidden()
    sidebar.bridge_event('desktop:presentation',{'collapsed':False}); assert not sidebar.body.isHidden()
    previous_size=window.size()
    bridge.mode='local'; bridge.presentation.dock(); app.processEvents(); bridge.presentation.collapse(True); app.processEvents()
    assert sidebar.width()==48 and sidebar.rail.width()==32 and sidebar.rail.geometry().right()<sidebar.width()
    bridge.presentation.collapse(False); app.processEvents(); assert sidebar.width()==380 and sidebar.body.isVisible()
    sidebar.recorder.start('math'); sidebar.close_sidebar(); app.processEvents()
    assert bridge.presentation.hidden and sidebar.isHidden() and bridge.presentation.player.isVisible() and not sidebar.recorder.timer.isActive()
    bridge.presentation.player.set_fullscreen(True); app.processEvents(); assert sidebar.isHidden()
    bridge.presentation.player.set_fullscreen(False); app.processEvents(); assert sidebar.isHidden()
    bridge.presentation.toggle_sidebar(); app.processEvents(); assert not bridge.presentation.hidden and sidebar.isVisible()
    bridge.presentation.restore(); app.processEvents()
    assert window.width()==previous_size.width() and window.height()<=previous_size.height(), '退出播放器恢复侧栏宽度，并适合当前屏幕'
    bridge.mode='window'; sidebar.close_sidebar(); app.processEvents(); assert window.isMinimized()
    bridge.presentation.show_sidebar(); app.processEvents(); assert not window.isMinimized()
    for locale in ('en','zh-TW','zh-CN'):
        sidebar.ui_language.setCurrentIndex(sidebar.ui_language.findData(locale)); sidebar.change_language(sidebar.ui_language.currentIndex()); app.processEvents()
        assert sidebar.tabs.tabText(0)=={'en':'Ask','zh-TW':'提問','zh-CN':'提问'}[locale]
        assert sidebar.backend.itemData(0)==('opencode-go' if locale=='zh-CN' else 'codex')
        sidebar.title.setText('用户标题保持原样'); sidebar.apply_language(); assert sidebar.title.text()=='用户标题保持原样'
    sidebar.model.clear(); sidebar.model.addItem('Readable name','actual-model-id'); sidebar.save_settings(); assert store.setting('assistant')['model']=='actual-model-id'
    sidebar.question.clear(); sidebar.title.setText('单位距离猜想 · 学习空间'); app.processEvents()
    artifacts=root/'artifacts'; artifacts.mkdir(exist_ok=True); window.grab().save(str(artifacts/'native-sidebar.png'))
    for index in range(sidebar.tabs.count()):sidebar.tabs.setCurrentIndex(index); app.processEvents(); assert sidebar.tabs.currentWidget().isVisible()
    assert not any('QtWebEngine' in name for name in sys.modules)
    sidebar.shutdown(); window.hide(); bridge.player.stop(); bridge.capture.stop(); bridge.presentation.timer.stop()
    report={'passed':True,'nativeWidgets':True,'webEngineImported':False,'videoChatIsolation':True,'draftIsolation':True,'canceledSourcePreserved':True,'collapseExpand':True,'trueSidebarCloseAndReopen':True,'closedSidebarStaysClosedInFullscreen':True,'externalSidebarMinimizesToTaskbar':True,'localeAndChannelOrder':True,'modelIdPreserved':True,'tabs':sidebar.tabs.count(),'scope':'isolated-offscreen-ui-not-real-media-or-model'}
    (artifacts/'native-ui-check.json').write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report))
