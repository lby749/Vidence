"""Qt Widgets学习侧栏；不使用HTML页面、JavaScript或浏览器控件承载界面。"""
import base64
import json
import re
from pathlib import Path
import threading
import time
import uuid
from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QPixmap
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox,
    QFileDialog, QFormLayout, QFrame, QHBoxLayout, QInputDialog, QLabel, QLineEdit,
    QListWidget, QListWidgetItem, QMessageBox, QPushButton, QScrollArea, QSpinBox,
    QTabWidget, QTextBrowser, QTextEdit, QVBoxLayout, QWidget, QMenu)
from native_agent import NativeAgent
from native_recording import Recorder
from native_media import ROOT
from native_updates import check_updates
from app_version import VERSION
from ui_locale import ui_text


STYLE = '''
QWidget {font-family:"Segoe UI","Microsoft YaHei UI";font-size:13px;color:#242833;}
QMainWindow,QDialog {background:#f7f8fb;} QWidget#sidebar {background:#f8f9fc;}
QLabel#brand {font-size:20px;font-weight:600;} QLabel#muted {color:#757e8e;}
QFrame#source {background:white;border:1px solid #e6e9ef;border-radius:14px;}
QPushButton {background:#fff;border:1px solid #e1e5ed;border-radius:9px;padding:8px 12px;}
QPushButton:hover {background:#edf3ff;border-color:#c0d4fa;}
QPushButton:disabled {color:#9ba3af;background:#f4f5f8;}
QPushButton#primary {background:#087bff;color:white;border:0;font-weight:600;}
QPushButton#primary:hover {background:#0064df;}
QLineEdit,QTextEdit,QTextBrowser,QListWidget,QComboBox,QSpinBox {background:white;border:1px solid #e3e7ef;border-radius:9px;padding:7px;selection-background-color:#d8e8ff;selection-color:#183a6d;}
QListWidget::item {padding:10px 8px;border-radius:7px;} QListWidget::item:selected {background:#e9f1ff;color:#174880;}
QTabWidget::pane {border:0;} QTabBar::tab {color:#748094;padding:10px 9px;border-bottom:2px solid transparent;}
QTabBar::tab:selected {color:#087bff;border-bottom:2px solid #087bff;} QTabBar::tab:hover {background:#eef3fb;}
QScrollArea {border:0;background:transparent;} QCheckBox {spacing:7px;} QToolTip {background:white;border:1px solid #dce1eb;padding:5px;}
'''


class SafeText(QTextBrowser):
    """模型输出只能作为文字显示；禁止自动加载远程或本机资源。"""
    def __init__(self):
        super().__init__(); self.setOpenLinks(False); self.setOpenExternalLinks(False)
        self.anchorClicked.connect(lambda url: QDesktopServices.openUrl(url) if url.scheme() in ('https', 'http') else None)
    def loadResource(self, resource_type, url): return None


class Job(QObject):
    done = Signal(object)
    failed = Signal(str)
    progress = Signal(str)
    def __init__(self, parent): super().__init__(parent); self.cancel = threading.Event()
    def run(self, action):
        def work():
            try: self.done.emit(action())
            except Exception as error: self.failed.emit(str(error))
        threading.Thread(target=work, daemon=True).start()


def button(text, action, primary=False):
    widget = QPushButton(text); widget.clicked.connect(action)
    if primary: widget.setObjectName('primary')
    return widget


def page():
    widget = QWidget(); layout = QVBoxLayout(widget); layout.setContentsMargins(0, 10, 0, 0); layout.setSpacing(10)
    return widget, layout


class NativeSidebar(QWidget):
    def __init__(self, window, bridge, store, models):
        super().__init__(); self.setObjectName('sidebar')
        self.window, self.bridge, self.store, self.models = window, bridge, store, models
        self.video_id = None; self.jobs = []; self.ai_job = None; self.token = ''; self.bootstrapping=False
        self.recorder = Recorder(bridge, store)
        self.recorder.changed.connect(self.record_changed); self.recorder.problem.connect(self.set_status)
        self.recorder.ocr_requested.connect(self.ocr)
        self.root_layout = QVBoxLayout(self); self.root_layout.setContentsMargins(14, 16, 14, 14); self.root_layout.setSpacing(10)
        self.rail = button('›', lambda: bridge.collapseSidebar(False)); self.rail.setFixedSize(32,40); self.rail.hide(); self.root_layout.addWidget(self.rail)
        self.body = QWidget(); self.root_layout.addWidget(self.body)
        layout = QVBoxLayout(self.body); layout.setContentsMargins(0,0,0,0); layout.setSpacing(12)
        header = QHBoxLayout(); logo = QLabel(); logo.setPixmap(QPixmap(str(ROOT/'public/brand/icon-128.png')).scaled(28,28,Qt.AspectRatioMode.KeepAspectRatio,Qt.TransformationMode.SmoothTransformation)); header.addWidget(logo)
        brand = QLabel('Vidence'); brand.setObjectName('brand'); header.addWidget(brand); header.addStretch()
        self.collapse = button('‹', self.toggle_collapse); self.collapse.setToolTip('收起学习栏'); header.addWidget(self.collapse)
        self.close_sidebar_button=button('×',self.close_sidebar); self.close_sidebar_button.setAccessibleName('关闭学习栏'); self.close_sidebar_button.setToolTip('关闭学习栏并停止记录，视频继续播放'); header.addWidget(self.close_sidebar_button); layout.addLayout(header)
        self.title = QLabel('把看过的，变成自己的。'); self.title.setWordWrap(True); self.title.setStyleSheet('font-size:17px;font-weight:600;'); layout.addWidget(self.title)
        self.title.setProperty('userContent',True)
        self.source_toggle = button('打开视频或课程  ▾', lambda: self.source_panel.setVisible(not self.source_panel.isVisible())); layout.addWidget(self.source_toggle)
        self.source_panel = QFrame(); self.source_panel.setObjectName('source'); form = QVBoxLayout(self.source_panel); form.setContentsMargins(12,12,12,12); form.setSpacing(9)
        source_buttons = QHBoxLayout(); source_buttons.addWidget(button('本地视频', self.open_local, True)); source_buttons.addWidget(button('课程窗口', self.pick_window)); form.addLayout(source_buttons)
        self.address = QLineEdit(); self.address.setPlaceholderText('粘贴课程网址，或输入网站地址'); form.addWidget(self.address)
        row = QHBoxLayout(); self.browser = QComboBox()
        choices = json.loads(bridge.browsers())
        # 桌面默认打开用户浏览器；应用内网页仅借用系统WebView2，界面仍为原生控件。
        for choice in sorted(choices, key=lambda item: item['id'] != 'default'): self.browser.addItem(choice['title'], choice['id'])
        row.addWidget(self.browser, 1); row.addWidget(button('打开', self.open_web)); form.addLayout(row)
        self.lesson_name = QLineEdit(); self.lesson_name.setPlaceholderText('这节课的名称'); self.lesson_name.editingFinished.connect(self.rename); form.addWidget(self.lesson_name)
        layout.addWidget(self.source_panel)
        actions = QHBoxLayout(); self.record = button('开始记录', self.toggle_record, True); self.record.setObjectName('primary'); actions.addWidget(self.record)
        self.capture = button('记下画面', lambda: self.recorder.sample(True)); actions.addWidget(self.capture); self.attach = button('靠在视频旁', self.attach_sidebar); actions.addWidget(self.attach); layout.addLayout(actions)
        self.status = QLabel('打开一个视频，开始学习。'); self.status.setObjectName('muted'); self.status.setWordWrap(True); layout.addWidget(self.status)
        self.tabs = QTabWidget(); layout.addWidget(self.tabs, 1)
        self.chat_page(); self.notes_page(); self.memory_page(); self.library_page(); self.settings_page()
        self.quick_model.setModel(self.model.model()); self.quick_model.setCurrentIndex(self.model.currentIndex())
        self.model.currentIndexChanged.connect(self.quick_model.setCurrentIndex)
        self.quick_model.currentIndexChanged.connect(self.model.setCurrentIndex)
        self.model.editTextChanged.connect(self.quick_model.setEditText); self.quick_model.editTextChanged.connect(self.model.setEditText)
        self.quick_model.activated.connect(lambda _index:self.save_settings())
        self.quick_model.lineEdit().returnPressed.connect(self.save_settings)
        for control in (self.route,self.backend,self.api_service):control.currentIndexChanged.connect(self.assistant_label)
        self.assistant_label()
        bridge.changed.connect(self.bridge_event)
        self.record_changed(); self.refresh_library()
        self.apply_language()
        QTimer.singleShot(0, self.bootstrap)
        QTimer.singleShot(1500,lambda:self.check_updates(False))

    def start_job(self, action, done, ai=False):
        if ai and self.ai_job: self.set_status('正在处理上一个请求，可以先取消。'); return
        job = Job(self); self.jobs.append(job)
        if ai: self.ai_job = job; self.send.setEnabled(False); self.cancel_button.show()
        def finish():
            if job in self.jobs: self.jobs.remove(job)
            if self.ai_job is job: self.ai_job = None; self.send.setEnabled(True); self.cancel_button.hide()
        job.done.connect(lambda value: (finish(), done(value)) if not job.cancel.is_set() else finish())
        job.failed.connect(lambda error: (finish(), self.set_status(error if not job.cancel.is_set() else '已取消')))
        job.progress.connect(self.set_status)
        job.run(lambda: action(job)); return job

    def agent(self, job): return NativeAgent(self.store, self.token, job.progress.emit, job.cancel,self.models)

    def bootstrap(self):
        # 仅建立本机配对；不读取或显示智能体的登录凭据。
        if self.route.currentData()!='local-agent' or self.bootstrapping:return
        self.bootstrapping=True
        def connect(job):
            saved=self.store.setting('bridgeToken','')
            if saved:
                try:NativeAgent(self.store,saved,cancel=job.cancel).bridge('/health'); return {'token':saved}
                except Exception:
                    if job.cancel.is_set():raise
            return json.loads(self.bridge.bootstrap())
        def done(value):
            self.bootstrapping=False
            if self.route.currentData()!='local-agent':return
            if value.get('error'):
                self.set_status(value['error'])
                if value.get('existingBridge'):self.existing_panel.show()
            else:self.token=value['token']; self.discover()
        job=self.start_job(connect,done)
        job.failed.connect(lambda error:setattr(self,'bootstrapping',False))

    def display_text(self,control,text):
        translated=ui_text(text,self.store.setting('uiLanguage','zh-CN')); control.setProperty('uiOriginal',text); control.setProperty('uiTranslated',translated); control.setText(translated)

    def set_status(self, text): self.display_text(self.status,str(text)[:350])

    def toggle_collapse(self):
        if self.bridge.presentation.docked or self.bridge.presentation.target: self.bridge.collapseSidebar(True)
        else: self.source_panel.setVisible(not self.source_panel.isVisible())

    def close_sidebar(self):
        self.bridge.hideSidebar()

    def attach_sidebar(self):
        if self.video_id and (not self.bridge.current_source or self.bridge.current_source['id'] != self.video_id):
            video = self.store.video(self.video_id)
            if video.get('url','').startswith('vma-course:'):self.pick_window(video); return
            result = json.loads(self.bridge.openSource(video['url'],0))
            if result.get('error'): self.set_status(result['error']); return
            if not result.get('source'): self.set_status('请重新选择这节课程的实际窗口，再继续记录。'); return
        result = json.loads(self.bridge.attachSidebar())
        if result.get('error'): self.set_status(result['error'])

    def bridge_event(self, name, value):
        if name=='desktop:sidebar-hidden':
            self.recorder.stop()
            if self.ai_job:self.ai_job.cancel.set()
            if self.video_id:self.store.set_setting('draft:'+self.video_id,self.question.toPlainText())
            if self.bridge.mode=='window':self.bridge.capture.stop()
        elif name == 'desktop:presentation':
            collapsed=bool(value.get('collapsed'))
            self.body.setVisible(not collapsed); self.rail.setVisible(collapsed); self.root_layout.setContentsMargins(8,8,8,8) if collapsed else self.root_layout.setContentsMargins(14,16,14,14)
        elif name == 'desktop:source-changed': self.select_source(value)
        elif name == 'desktop:source-title' and value.get('id') == self.video_id:
            previous = self.store.video(self.video_id)
            if previous and not previous.get('customTitle'): previous.update(title=value['title']); self.store.save_video(previous); self.title.setText(previous['title']); self.lesson_name.setText(previous['title']); self.refresh_library()
        elif name == 'desktop:playback-error': self.set_status(value)

    def select_source(self, source):
        if source.get('error'): self.set_status(source['error']); return
        if not source.get('id'): return
        if source['id'] != self.video_id:
            self.recorder.stop()
            if self.ai_job: self.ai_job.cancel.set()
            if self.video_id: self.store.set_setting('draft:'+self.video_id, self.question.toPlainText())
            self.video_id = source['id']
            self.scope.setCurrentIndex(0)
            video = self.store.video(self.video_id) or dict(source, createdAt=int(time.time()*1000))
            self.store.save_video(video)
            self.question.setPlainText(self.store.setting('draft:'+self.video_id, ''))
        video = self.store.video(self.video_id)
        self.title.setText(video['title']); self.lesson_name.setText(video['title']); self.display_text(self.source_toggle,'切换视频或课程  ▾')
        self.source_panel.hide(); self.refresh_current(); self.refresh_library(); self.set_status('资料和聊天只属于这一个视频。')

    def open_local(self):
        # 取消文件选择不会改变当前来源、聊天草稿或记录状态。
        file, _ = QFileDialog.getOpenFileName(self, '选择视频', '', 'Video (*.mp4 *.m4v *.mkv *.mov *.webm *.avi);;All files (*)')
        if not file: return
        source = json.loads(self.bridge.load_video(file))
        if source.get('error'): self.set_status(source['error']); return
        self.select_source(source); self.bridge.presentation.attach()

    def open_web(self):
        if not self.address.text().strip(): return
        result = json.loads(self.bridge.openWebPage(self.address.text(), self.browser.currentData()))
        if result.get('error'): self.set_status(result['error'])
        elif not result.get('inApp'): self.set_status('已在浏览器打开；用浏览器插件学习，或选择“课程窗口”挂靠原生学习栏。')

    def pick_window(self,existing_video=None):
        if not isinstance(existing_video,dict):existing_video=None
        candidates = json.loads(self.bridge.windows())
        if not candidates: self.set_status('没有找到可记录的窗口，请先打开课程。'); return
        dialog = QDialog(self); dialog.setWindowTitle('选择课程窗口'); dialog.resize(520,460); layout = QVBoxLayout(dialog)
        listing = QListWidget(); layout.addWidget(listing)
        for candidate in candidates:
            item = QListWidgetItem(candidate['title']); item.setData(Qt.ItemDataRole.UserRole, candidate); listing.addItem(item)
        actions = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok|QDialogButtonBox.StandardButton.Cancel); actions.accepted.connect(dialog.accept); actions.rejected.connect(dialog.reject); layout.addWidget(actions)
        if dialog.exec() != QDialog.DialogCode.Accepted or not listing.currentItem(): return
        candidate = listing.currentItem().data(Qt.ItemDataRole.UserRole)
        if existing_video:title=existing_video['title']
        else:
            title, accepted = QInputDialog.getText(self, '课程名称', '给这节课起个名称。每次新选课程会独立保存，续学已有课程请从视频库打开。', text=candidate['title'])
            if not accepted or not title.strip(): return
        result = json.loads(self.bridge.captureWindow(candidate['id']))
        if result.get('error'): self.set_status(result['error']); return
        identifier = existing_video['id'] if existing_video else 'course_'+uuid.uuid4().hex
        from presentation import window_title
        source = {'id': identifier, 'title': title.strip(), 'url': 'vma-course://lesson/'+identifier, 'kind': 'window','captureTitle':window_title(self.bridge.target_window) or candidate['title']}
        self.bridge.current_source = source; self.select_source(source); self.attach_sidebar()

    def rename(self):
        if not self.video_id or not self.lesson_name.text().strip(): return
        video = self.store.video(self.video_id); video.update(title=self.lesson_name.text().strip(), customTitle=True); self.store.save_video(video); self.title.setText(video['title']); self.refresh_library()

    def toggle_record(self):
        if self.recorder.video_id: self.recorder.stop(); self.set_status('已停止记录，已有资料保留。')
        elif self.video_id and self.bridge.current_source and self.bridge.current_source['id'] == self.video_id:
            if self.bridge.mode=='window' and not self.bridge.capture.isActive():self.bridge.resumeCapture()
            self.recorder.start(self.video_id); self.set_status('正在本机记录变化画面；播放保持原始分辨率和帧率。')
        else: self.set_status('请先打开或关联这个视频。')

    def record_changed(self):
        active = bool(self.recorder.video_id); self.display_text(self.record,'停止记录' if active else '开始记录'); self.capture.setEnabled(active)
        if hasattr(self, 'frames'): self.refresh_notes()

    def ocr(self, video_id, frame_id, image, stamp):
        from native_ocr import recognize
        job = self.start_job(lambda job: recognize(image, self.store.setting('ocrLanguage', 'auto')), lambda text: self.recorder.save_text(video_id, frame_id, stamp, text))
        job.failed.connect(lambda _error: setattr(self.recorder, 'ocr_busy', False))

    def chat_page(self):
        widget, layout = page(); self.tabs.addTab(widget, '提问')
        tools=QHBoxLayout(); self.quick_assistant=QPushButton('AI 助手'); self.quick_assistant.setAccessibleName('切换 AI 助手'); self.quick_assistant.setProperty('userContent',True)
        self.assistant_menu=QMenu(self.quick_assistant); self.quick_assistant.setMenu(self.assistant_menu); self.assistant_menu.aboutToShow.connect(self.assistant_options)
        self.quick_model=QComboBox(); self.quick_model.setEditable(True); self.quick_model.setMaxVisibleItems(10); self.quick_model.setMinimumContentsLength(6)
        self.quick_model.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon); self.quick_model.setAccessibleName('当前问答模型')
        self.quick_model.lineEdit().setPlaceholderText('选择或搜索模型'); self.quick_model.completer().setFilterMode(Qt.MatchFlag.MatchContains); self.quick_model.completer().setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        tools.addWidget(self.quick_assistant); tools.addWidget(self.quick_model,1); layout.addLayout(tools)
        self.scope=QComboBox(); self.scope.addItem('整个视频',None); layout.addWidget(self.scope)
        self.chat = SafeText(); layout.addWidget(self.chat,1)
        self.references = QListWidget(); self.references.setMaximumHeight(85); self.references.hide(); self.references.itemActivated.connect(self.show_reference); layout.addWidget(self.references)
        self.question = QTextEdit(); self.question.setPlaceholderText('就这个视频提问…'); self.question.setMaximumHeight(110); layout.addWidget(self.question)
        row = QHBoxLayout(); self.allow_images = QCheckBox('本次允许读图'); row.addWidget(self.allow_images); row.addStretch()
        self.cancel_button = button('取消', lambda: self.ai_job.cancel.set() if self.ai_job else None); self.cancel_button.hide(); row.addWidget(self.cancel_button)
        self.send = button('发送', self.ask, True); row.addWidget(self.send); layout.addLayout(row)

    def assistant_label(self):
        self.quick_assistant.setText(self.api_service.currentText() if self.route.currentData()=='api' else self.backend.currentText())

    def assistant_options(self):
        self.assistant_menu.clear()
        api=self.assistant_menu.addAction('API Key'); api.setCheckable(True); api.setChecked(self.route.currentData()=='api'); api.triggered.connect(lambda:self.switch_assistant('api'))
        for index in range(self.backend.count()):
            backend=self.backend.itemData(index); action=self.assistant_menu.addAction(self.backend.itemText(index)); action.setCheckable(True)
            action.setChecked(self.route.currentData()=='local-agent' and self.backend.currentData()==backend)
            action.triggered.connect(lambda _checked=False,value=backend:self.switch_assistant('local-agent',value))
        self.assistant_menu.addSeparator(); self.assistant_menu.addAction(ui_text('连接设置',self.store.setting('uiLanguage','zh-CN')),lambda:self.tabs.setCurrentIndex(4))

    def switch_assistant(self,route,backend=None):
        if self.ai_job:self.set_status('请先等待或取消当前请求。'); return
        self.route.setCurrentIndex(self.route.findData(route))
        if backend is not None:self.backend.setCurrentIndex(self.backend.findData(backend))
        self.save_settings(); self.assistant_label()
        if route=='api' and not self.api_key.text().strip():self.tabs.setCurrentIndex(4); self.set_status('请先用 API Key 连接服务。'); return
        if route=='local-agent' and not self.token:self.bootstrap(); return
        self.discover()

    def ask(self):
        if not self.video_id: self.set_status('请先选择一个视频。'); return
        question = self.question.toPlainText().strip()
        if not question: return
        if self.allow_images.isChecked() and not self.store.setting('allowVisionUpload', False): self.set_status('请先在设置中开启截图发送；每次提问仍由你单独授权。'); return
        video_id = self.video_id; allow = self.allow_images.isChecked(); bounds=self.scope.currentData()
        def done(result):
            if self.video_id == video_id:
                self.question.clear(); self.store.set_setting('draft:'+video_id, ''); self.refresh_chat(); self.set_status(f'回答完成 · 本次读取 {result["images"]} 张原图')
        self.start_job(lambda job: self.agent(job).ask(video_id, question, allow,bounds=bounds), done, True)

    def refresh_chat(self):
        rows = self.store.rows('chats', self.video_id) if self.video_id else []
        self.chat.setMarkdown('\n\n---\n\n'.join('**你**\n\n'+row['question']+'\n\n**Vidence**\n\n'+row['answer'] for row in rows[-40:]) or '在这里提问，回答会结合这一个视频的笔记和长期记忆。')
        self.chat.moveCursor(self.chat.textCursor().MoveOperation.End)
        self.references.clear()
        for row in rows[-1:]:
            for reference in row.get('frames', []):
                item = QListWidgetItem(f'已读取原图 · {reference["time"]:.1f}s · {reference["id"][:8]}'); item.setData(Qt.ItemDataRole.UserRole,reference); self.references.addItem(item)
        self.references.setVisible(bool(self.references.count()))

    def show_reference(self, item):
        reference = item.data(Qt.ItemDataRole.UserRole)
        frame = self.store.get('keyframes', self.video_id, reference['id'])
        if frame and reference.get('videoId') == self.video_id: self.show_frame(frame)

    def notes_page(self):
        widget, layout = page(); self.tabs.addTab(widget, '笔记')
        row = QHBoxLayout(); row.addWidget(button('整理重点', self.organize)); row.addWidget(button('添加文字', self.add_text)); row.addWidget(button('记录区域', self.ocr_region)); layout.addLayout(row)
        self.notes = SafeText(); layout.addWidget(self.notes,1)
        frame_actions=QHBoxLayout(); frame_actions.addWidget(button('读取原图并筛选',self.review_frames)); self.show_filtered=QCheckBox('显示已过滤画面'); self.show_filtered.toggled.connect(self.refresh_notes); frame_actions.addWidget(self.show_filtered); layout.addLayout(frame_actions)
        self.frames = QListWidget(); self.frames.setMaximumHeight(190); self.frames.itemActivated.connect(lambda item: self.show_frame(item.data(Qt.ItemDataRole.UserRole))); layout.addWidget(self.frames)

    def refresh_notes(self):
        if not hasattr(self, 'notes'): return
        notes = self.store.rows('nodes', self.video_id) if self.video_id else []
        previous=self.scope.currentData(); self.scope.clear(); self.scope.addItem('整个视频',None)
        for note in notes:self.scope.addItem(f'{note.get("startTime",0):.0f}–{note.get("endTime",0):.0f}s · '+note.get('summary','').replace('\n',' ')[:32],(note.get('startTime',0),note.get('endTime',0)))
        if previous:self.scope.setCurrentIndex(max(0,self.scope.findData(previous)))
        self.notes.setMarkdown(('> AI 整理笔记。画面文字识别可能有误，重要公式和表格请打开原图核对。\n\n' if notes else '')+'\n\n---\n\n'.join(f'**{row.get("startTime",0):.0f}s**\n\n'+row.get('summary','') for row in notes) or '原始文字会先概括，再进入问答上下文。')
        self.frames.clear()
        for frame in self.store.rows('keyframes', self.video_id) if self.video_id else []:
            review = frame.get('review', {}); tag = '保留' if frame.get('manualKeep') else review.get('kind','待筛选')
            if not self.show_filtered.isChecked() and not frame.get('manualKeep') and review.get('kind') in ('speaker','intro','outro'):continue
            clock='记录 ' if frame.get('timeSource')=='recording' else ''
            item = QListWidgetItem(f'{clock}{frame.get("time",0):.1f}s · {tag} · {review.get("title", "画面记录")}'); item.setData(Qt.ItemDataRole.UserRole,frame); self.frames.addItem(item)

    def review_frames(self):
        if not self.video_id:return
        video_id=self.video_id
        self.start_job(lambda job:self.agent(job).review_frames(video_id),lambda count:(self.refresh_notes(),self.set_status(f'已筛选 {count} 张原图；过滤结果可展开和恢复。')),True)

    def add_text(self):
        if not self.video_id: self.set_status('请先选择视频。'); return
        text, accepted = QInputDialog.getMultiLineText(self, '添加本视频文字', '粘贴字幕片段或记下知识点；不会直接塞入问答上下文。')
        if accepted and text.strip():
            stamp = self.bridge.player.position()/1000 if self.bridge.mode == 'local' else 0
            self.store.put('evidence', self.video_id, {'id': uuid.uuid4().hex, 'text':text.strip()[:4000], 'startTime':stamp, 'endTime':stamp, 'source':'manual'})
            self.set_status('文字已保存在本视频，提问前会先概括。')

    def organize(self):
        if not self.video_id: return
        video_id = self.video_id
        self.start_job(lambda job: self.agent(job).organize(video_id), lambda value: (self.refresh_notes(),self.set_status('本视频重点已整理。')), True)

    def show_frame(self, frame):
        dialog = QDialog(self.window); dialog.setWindowTitle(f'原图 · {frame.get("time",0):.1f}s'); dialog.resize(1000,700); layout = QVBoxLayout(dialog)
        image = QPixmap(); image.loadFromData(base64.b64decode(frame['imageDataUrl'].split(',',1)[1]))
        area = QScrollArea(); label = QLabel(); label.setPixmap(image); area.setWidget(label); area.setWidgetResizable(False); layout.addWidget(area,1)
        row = QHBoxLayout(); row.addWidget(QLabel(f'{frame.get("width",image.width())} × {frame.get("height",image.height())} · {frame["id"]}'))
        def keep():
            frame['manualKeep'] = True; self.store.put('keyframes', frame['videoId'], frame); self.refresh_notes(); dialog.accept()
        row.addWidget(button('保留这张画面',keep)); row.addWidget(button('回到片段',lambda: self.bridge.openSource(self.store.video(frame['videoId'])['url'],frame.get('time',0)))); layout.addLayout(row); dialog.exec()

    def ocr_region(self):
        image = self.bridge.latest_frame.toImage()
        if image.isNull(): self.set_status('请先让视频显示画面。'); return
        from native_ui_region import RegionDialog
        dialog = RegionDialog(image, self)
        if dialog.exec() == QDialog.DialogCode.Accepted: self.store.set_setting('ocrRegion',dialog.region); self.set_status('文字识别区域已更新。')

    def memory_page(self):
        widget, layout = page(); self.tabs.addTab(widget, '记忆')
        info = QLabel('每个视频独立保存。你可以修改、锁定，再用于复习和问答。'); info.setWordWrap(True); info.setObjectName('muted'); layout.addWidget(info)
        self.memory_text = QTextEdit(); layout.addWidget(self.memory_text,1)
        self.memory_lock = QCheckBox('锁定这份记忆，避免自动改写'); layout.addWidget(self.memory_lock)
        row=QHBoxLayout(); row.addWidget(button('生成记忆',self.build_memory,True)); row.addWidget(button('保存修改',self.save_memory)); row.addWidget(button('历史版本',self.memory_history)); layout.addLayout(row)

    def refresh_memory(self):
        memory = self.store.memory(self.video_id) if self.video_id else None
        self.memory_text.setPlainText((memory or {}).get('body','')); self.memory_lock.setChecked(bool((memory or {}).get('locked')))

    def build_memory(self):
        if not self.video_id: return
        video_id = self.video_id
        self.start_job(lambda job: self.agent(job).build_memory(video_id),lambda value:(self.refresh_memory(),self.set_status('长期记忆已更新，只用于这一个视频。')),True)

    def save_memory(self):
        if not self.video_id: return
        previous = self.store.memory(self.video_id) or {}
        self.store.save_memory(self.video_id,self.memory_text.toPlainText(),previous.get('sources',[]),self.memory_lock.isChecked(),manual=True); self.set_status('修改已保存，旧版本保留。')

    def memory_history(self):
        if not self.video_id: return
        versions = (self.store.memory(self.video_id) or {}).get('versions', [])
        if not versions: self.set_status('还没有历史版本。'); return
        labels = [f'版本 {value.get("revision",index+1)} · '+time.strftime('%Y-%m-%d %H:%M',time.localtime(value['updatedAt']/1000)) for index,value in enumerate(versions)]
        label, accepted = QInputDialog.getItem(self,'记忆历史','选择版本预览，保存修改后才会恢复。',labels,editable=False)
        if accepted: self.memory_text.setPlainText(versions[labels.index(label)]['body'])

    def library_page(self):
        widget, layout = page(); self.tabs.addTab(widget, '视频库')
        self.search = QLineEdit(); self.search.setPlaceholderText('搜索视频名称'); self.search.textChanged.connect(self.refresh_library); layout.addWidget(self.search)
        self.library = QListWidget(); self.library.itemActivated.connect(self.select_library); layout.addWidget(self.library,1)
        row=QHBoxLayout(); row.addWidget(button('导入资料',self.import_data)); row.addWidget(button('导出所选',self.export_data)); row.addWidget(button('生成所选记忆',self.selected_memories)); layout.addLayout(row)

    def refresh_library(self):
        self.library.clear()
        for video in self.store.videos():
            if self.search.text().lower() not in video['title'].lower(): continue
            item=QListWidgetItem(video['title']); item.setData(Qt.ItemDataRole.UserRole,video); item.setFlags(item.flags()|Qt.ItemFlag.ItemIsUserCheckable); item.setCheckState(Qt.CheckState.Unchecked); self.library.addItem(item)

    def select_library(self,item):
        video=item.data(Qt.ItemDataRole.UserRole); self.select_source(video); self.tabs.setCurrentIndex(0)
        self.set_status('已打开这一个视频的资料。点击“靠在视频旁”前请先回到原视频。')

    def selected_videos(self):
        return [self.library.item(index).data(Qt.ItemDataRole.UserRole)['id'] for index in range(self.library.count()) if self.library.item(index).checkState()==Qt.CheckState.Checked]

    def selected_memories(self):
        identifiers=self.selected_videos()
        if not identifiers: self.set_status('请先勾选要整理的视频，每个视频会分别生成。'); return
        self.start_job(lambda job:[self.agent(job).build_memory(identifier) for identifier in identifiers],lambda value:(self.refresh_memory(),self.set_status(f'已分别生成 {len(value)} 份记忆。')),True)

    def export_data(self):
        identifiers=self.selected_videos() or ([self.video_id] if self.video_id else [])
        if not identifiers: self.set_status('请先选择视频。'); return
        file,_=QFileDialog.getSaveFileName(self,'导出学习资料','Vidence-learning.json','JSON (*.json)')
        if file: Path(file).write_text(json.dumps(self.store.export(identifiers),ensure_ascii=False),encoding='utf8'); self.set_status('所选视频已导出，不包含设置和密钥。')

    def import_data(self):
        file,_=QFileDialog.getOpenFileName(self,'导入学习资料（包括旧版导出）','','JSON (*.json)')
        if not file: return
        try:
            if Path(file).stat().st_size>120*1024*1024:raise ValueError('资料文件超过120MB')
            result=self.store.import_bundle(json.loads(Path(file).read_text(encoding='utf8'))); self.refresh_library(); self.refresh_current(); self.set_status(f'已导入 {result["videos"]} 个视频。')
        except Exception: self.set_status('导入失败，文件格式或来源引用无效；原资料未改动。')

    def settings_page(self):
        widget, outer=page(); self.tabs.addTab(widget,'设置'); area=QScrollArea(); area.setWidgetResizable(True); outer.addWidget(area)
        body=QWidget(); layout=QVBoxLayout(body); layout.setContentsMargins(2,2,2,2); layout.setSpacing(10); area.setWidget(body)
        form=QFormLayout(); self.route=QComboBox(); self.route.addItem('已有智能体','local-agent'); self.route.addItem('API Key','api')
        self.ui_language=QComboBox()
        for label,value in [('简体中文','zh-CN'),('繁體中文','zh-TW'),('English','en')]:self.ui_language.addItem(label,value)
        self.ui_language.setCurrentIndex(max(0,self.ui_language.findData(self.store.setting('uiLanguage','zh-CN')))); form.addRow('界面语言',self.ui_language)
        self.backend=QComboBox()
        for label,value in [('OpenCode Go','opencode-go'),('DeepSeek Harness','dsh'),('Codex CLI','codex'),('Claude Code','claude')]: self.backend.addItem(label,value)
        self.base_url=QLineEdit(); self.base_url.setPlaceholderText('https://服务商地址/v1')
        self.api_key=QLineEdit(); self.api_key.setEchoMode(QLineEdit.EchoMode.Password); self.api_key.setPlaceholderText('仅保存在本机，不随学习资料导出')
        self.model=QComboBox(); self.model.setEditable(True); self.model.setMaxVisibleItems(12); self.model.setMinimumContentsLength(16); self.model.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon); self.model.addItem('deepseek-v4.1-flash','deepseek-v4.1-flash'); self.model.completer().setFilterMode(Qt.MatchFlag.MatchContains); self.model.completer().setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self.api_service=QComboBox()
        for label,value in [('DeepSeek',('deepseek','https://api.deepseek.com/v1','openai')),('SiliconFlow',('siliconflow','https://api.siliconflow.cn/v1','openai')),('OpenRouter',('openrouter','https://openrouter.ai/api/v1','openai')),('OpenAI',('openai','https://api.openai.com/v1','openai')),('Anthropic',('anthropic','https://api.anthropic.com/v1','anthropic')),('自定义',('custom','','openai'))]:self.api_service.addItem(label,value)
        self.protocol=QComboBox(); self.protocol.addItem('OpenAI compatible','openai'); self.protocol.addItem('Anthropic','anthropic'); form.addRow('服务商',self.api_service); form.addRow('API 协议',self.protocol)
        for label,control in [('连接方式',self.route),('智能体',self.backend),('API 地址',self.base_url),('API Key',self.api_key),('使用模型',self.model)]:form.addRow(label,control)
        self.settings_form=form; layout.addLayout(form); layout.addWidget(button('连接并获取可用模型',self.discover,True))
        self.existing_toggle=button('连接已有服务',lambda:self.existing_panel.setVisible(not self.existing_panel.isVisible())); layout.addWidget(self.existing_toggle)
        self.existing_panel=QWidget(); existing=QVBoxLayout(self.existing_panel); existing.setContentsMargins(0,0,0,0)
        explanation=QLabel('已经启动过本机智能体？可使用它生成的连接令牌。这里不填写 API Key。'); explanation.setWordWrap(True); existing.addWidget(explanation)
        self.bridge_token=QLineEdit(self.store.setting('bridgeToken','')); self.bridge_token.setEchoMode(QLineEdit.EchoMode.Password); self.bridge_token.setPlaceholderText('已有服务的连接令牌'); existing.addWidget(self.bridge_token)
        row=QHBoxLayout(); row.addWidget(button('选择配对文件',self.choose_pairing_file)); row.addWidget(button('连接',self.connect_existing)); existing.addLayout(row); self.existing_panel.hide(); layout.addWidget(self.existing_panel)
        self.vision=QCheckBox('允许 AI 读取画面'); self.vision.setToolTip('每次提问仍需勾选，不会自动上传保存的截图。'); layout.addWidget(self.vision)
        self.ocr_enabled=QCheckBox('识别视频里的文字'); self.ocr_enabled.setToolTip('在本机使用系统文字识别，不发送截图。'); layout.addWidget(self.ocr_enabled)
        self.resource_tier=QComboBox()
        for label,value in [('无占用 · 关键词检索','none'),('低占用 · 系统文字识别','low'),('中占用 · 文字识别与语义检索','medium'),('高占用 · 更频繁地记录文字','high')]:self.resource_tier.addItem(label,value)
        self.resource_tier.setCurrentIndex(max(0,self.resource_tier.findData(self.store.setting('resourceTier','none')))); self.resource_tier.activated.connect(self.change_resource_tier); layout.addWidget(self.resource_tier)
        self.ocr_language=QLineEdit(self.store.setting('ocrLanguage','auto')); self.ocr_language.setPlaceholderText('文字识别语言：auto / zh-Hans-CN / en-US'); layout.addWidget(self.ocr_language)
        self.answer_language=QLineEdit(self.store.setting('answerLanguage','跟随问题')); self.answer_language.setPlaceholderText('回答语言'); layout.addWidget(self.answer_language)
        self.answer_style=QComboBox(); self.answer_style.addItems(['清晰自然','简洁重点','循序渐进','深入讲解']); self.answer_style.setCurrentText(self.store.setting('answerStyle','清晰自然')); layout.addWidget(self.answer_style)
        self.frame_budget=QSpinBox(); self.frame_budget.setRange(10,300); self.frame_budget.setValue(self.store.setting('frameBudget',60)); self.frame_budget.setPrefix('每个视频最多 '); self.frame_budget.setSuffix(' 张候选画面'); layout.addWidget(self.frame_budget)
        layout.addWidget(button('保存设置',self.save_settings))
        download=button('下载离线检索资源',self.download_models); download.setToolTip('显卡优先，不可用时自动使用处理器。'); layout.addWidget(download)
        layout.addWidget(button('释放离线模型内存',lambda:self.models.unload()))
        self.auto_updates=QCheckBox('自动提醒应用新版本'); self.auto_updates.setChecked(self.store.setting('appUpdates',{}).get('auto',True)); self.auto_updates.toggled.connect(self.set_auto_updates); layout.addWidget(self.auto_updates)
        layout.addWidget(button('检查应用更新',lambda:self.check_updates(True)))
        self.update_download=button('下载新版 / 查看全部版本',lambda:QDesktopServices.openUrl(QUrl('https://github.com/lby749/Vidence/releases'))); layout.addWidget(self.update_download)
        layout.addWidget(button('反馈问题或建议',lambda:QDesktopServices.openUrl(QUrl('https://github.com/lby749/Vidence/issues/new/choose'))))
        note=QLabel('项目还在持续完善，欢迎提出建议。\n感谢您的支持，如果有帮助的话，请点一个 STAR，谢谢！'); note.setWordWrap(True); note.setObjectName('muted'); layout.addWidget(note); layout.addStretch()
        config=self.store.setting('assistant',{})
        self.api_service.setCurrentIndex(max(0,next((index for index in range(self.api_service.count()) if self.api_service.itemData(index)[0]==config.get('service','custom')),0))); self.protocol.setCurrentIndex(max(0,self.protocol.findData(config.get('protocol','openai'))))
        self.route.setCurrentIndex(max(0,self.route.findData(config.get('route','local-agent')))); self.backend.setCurrentIndex(max(0,self.backend.findData(config.get('backend','opencode-go')))); self.base_url.setText(config.get('baseUrl','')); self.api_key.setText(config.get('apiKey','')); self.model.setCurrentText(config.get('model','deepseek-v4.1-flash')); self.vision.setChecked(self.store.setting('allowVisionUpload',False)); self.ocr_enabled.setChecked(self.store.setting('ocrEnabled',False))
        self.route.currentIndexChanged.connect(self.route_changed); self.route_changed()
        self.ui_language.activated.connect(self.change_language); self.api_service.activated.connect(self.choose_service)

    def route_changed(self):
        api=self.route.currentData()=='api'
        for control in (self.base_url,self.api_key,self.api_service,self.protocol):self.settings_form.setRowVisible(control,api)
        self.settings_form.setRowVisible(self.backend,not api)
        self.existing_toggle.setVisible(not api)
        if api:self.existing_panel.hide()
        elif not self.token:QTimer.singleShot(0,self.bootstrap)

    def choose_pairing_file(self):
        file,_=QFileDialog.getOpenFileName(self,'选择已有服务的配对文件','','Pairing token (token *.token);;All files (*)')
        if not file:return
        try:
            if Path(file).stat().st_size>256:raise ValueError()
            value=Path(file).read_text(encoding='utf-8-sig').strip()
            if not re.fullmatch(r'[0-9a-fA-F]{64}',value):raise ValueError()
            self.bridge_token.setText(value); self.connect_existing()
        except Exception:self.set_status('这个文件不是有效的 Vidence 配对文件。')

    def connect_existing(self):
        token=self.bridge_token.text().strip()
        if not re.fullmatch(r'[0-9a-fA-F]{64}',token):self.set_status('请填写本机智能体生成的64位连接令牌，不要填写 API Key。'); return
        def done(value):
            self.token=token; self.store.set_setting('bridgeToken',token); self.set_status('已连接已有智能体服务，可以获取模型了。')
        self.start_job(lambda job:NativeAgent(self.store,token,cancel=job.cancel).bridge('/health'),done)

    def save_settings(self):
        selected = self.model.currentData() if self.model.currentIndex() >= 0 and self.model.currentText() == self.model.itemText(self.model.currentIndex()) else self.model.currentText().strip()
        self.store.set_setting('assistant',{'route':self.route.currentData(),'backend':self.backend.currentData(),'baseUrl':self.base_url.text().strip(),'apiKey':self.api_key.text().strip(),'model':selected,'protocol':self.protocol.currentData(),'service':self.api_service.currentData()[0]})
        for name,value in [('allowVisionUpload',self.vision.isChecked()),('ocrEnabled',self.ocr_enabled.isChecked()),('ocrLanguage',self.ocr_language.text().strip() or 'auto'),('answerLanguage',self.answer_language.text().strip()),('answerStyle',self.answer_style.currentText()),('frameBudget',self.frame_budget.value())]:self.store.set_setting(name,value)
        self.set_status('设置已保存在本机。')

    def discover(self):
        self.save_settings()
        selected=self.store.setting('assistant',{}).get('model','')
        connection=(self.route.currentData(),self.backend.currentData(),self.base_url.text(),self.protocol.currentData())
        def done(values):
            if connection!=(self.route.currentData(),self.backend.currentData(),self.base_url.text(),self.protocol.currentData()):return
            if not values:self.set_status('没有找到可用聊天模型，可以手动填写模型标识。'); return
            self.model.clear()
            for value in values:self.model.addItem(value.get('label',value['id']),value['id'])
            # 下拉显示可读名称，保存实际模型标识。
            self.model.setCurrentIndex(max(0,self.model.findData(selected)))
            self.save_settings(); self.set_status(f'连接成功，找到 {len(values)} 个可用模型。可以在提问栏直接选择。')
        self.start_job(lambda job:self.agent(job).models(),done,True)

    def download_models(self):
        self.start_job(lambda job:self.models.download(lambda loaded,total:job.progress.emit(f'正在下载离线检索资源 {loaded*100/max(total,1):.0f}%')),lambda value:self.set_status('下载完成。模型权重不会包含在发行包中。'))

    def change_resource_tier(self,index):
        value=self.resource_tier.itemData(index)
        self.store.set_setting('resourceTier',value); self.ocr_enabled.setChecked(value!='none'); self.store.set_setting('ocrEnabled',value!='none')
        if value in ('none','low'):self.start_job(lambda job:self.models.unload(),lambda value:self.set_status('已切换档位，离线检索模型已释放。'))
        else:self.download_models()

    def choose_service(self,index):
        identifier,base,protocol=self.api_service.itemData(index)
        if base:self.base_url.setText(base)
        self.protocol.setCurrentIndex(max(0,self.protocol.findData(protocol)))

    def change_language(self,index):
        self.store.set_setting('uiLanguage',self.ui_language.itemData(index)); self.apply_language()

    def apply_language(self):
        locale=self.store.setting('uiLanguage','zh-CN'); self.bridge.setUiLanguage(locale)
        for control in self.findChildren(QWidget):
            if control.property('userContent'):continue
            if isinstance(control,(QPushButton,QLabel,QCheckBox)):
                original=control.property('uiOriginal') if control.text()==control.property('uiTranslated') else control.text()
                translated=ui_text(original,locale); control.setProperty('uiOriginal',original); control.setProperty('uiTranslated',translated); control.setText(translated)
            if isinstance(control,(QLineEdit,QTextEdit)):
                original=control.property('uiPlaceholder') or control.placeholderText(); control.setProperty('uiPlaceholder',original); control.setPlaceholderText(ui_text(original,locale))
        for index,text in enumerate(('提问','笔记','记忆','视频库','设置')):self.tabs.setTabText(index,ui_text(text,locale))
        self.scope.setItemText(0,ui_text('整个视频',locale))
        for index in range(self.browser.count()):
            if self.browser.itemData(index) in ('default','in-app'):self.browser.setItemText(index,ui_text('系统默认浏览器' if self.browser.itemData(index)=='default' else '应用内播放（支持网页全屏）',locale))
        self.frame_budget.setPrefix('Per video: ' if locale=='en' else '每部影片最多 ' if locale=='zh-TW' else '每个视频最多 ')
        self.frame_budget.setSuffix(' candidate frames' if locale=='en' else ' 張候選畫面' if locale=='zh-TW' else ' 张候选画面')
        for combo in (self.route,self.resource_tier,self.answer_style):
            for index in range(combo.count()):
                original=combo.itemData(index,Qt.ItemDataRole.UserRole+1) or combo.itemText(index); combo.setItemData(index,original,Qt.ItemDataRole.UserRole+1); combo.setItemText(index,ui_text(original,locale))
        for combo,order in [(self.backend,['opencode-go','dsh','codex','claude'] if locale=='zh-CN' else ['codex','claude','opencode-go','dsh']), (self.api_service,['deepseek','siliconflow','openrouter','openai','anthropic','custom'] if locale=='zh-CN' else ['openai','anthropic','openrouter','deepseek','siliconflow','custom'])]:
            selected=combo.currentData(); rows=[(combo.itemText(index),combo.itemData(index)) for index in range(combo.count())]
            rows.sort(key=lambda row:order.index(row[1][0] if isinstance(row[1],tuple) else row[1])); combo.blockSignals(True); combo.clear()
            for label,value in rows:combo.addItem(label,value)
            combo.setCurrentIndex(max(0,combo.findData(selected))); combo.blockSignals(False)
        self.assistant_label()

    def set_auto_updates(self,enabled):
        saved=self.store.setting('appUpdates',{}); saved['auto']=enabled; self.store.set_setting('appUpdates',saved)

    def check_updates(self,force=False):
        if not force and not self.auto_updates.isChecked():return
        current=VERSION
        def done(result):
            if result.get('error'):
                if force:self.set_status(result['error'])
            elif result.get('update'):
                self.update_download.setText('下载新版 · '+result['update']['version']); self.set_status('有新的 Vidence 版本，可在设置中查看和下载。')
            elif force:self.set_status('已是当前渠道最新版本。')
        self.start_job(lambda job:check_updates(self.store,current,force),done)

    def refresh_current(self): self.refresh_chat(); self.refresh_notes(); self.refresh_memory()

    def shutdown(self):
        self.recorder.stop()
        if self.video_id:self.store.set_setting('draft:'+self.video_id,self.question.toPlainText())
        for job in self.jobs:job.cancel.set()
