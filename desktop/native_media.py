"""原生播放与采集桥接；不导入或启动 QtWebEngine。"""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from PySide6.QtCore import QBuffer, QIODevice, QObject, QUrl, Qt, Slot, Signal, QTimer
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QFileDialog, QMessageBox
from PySide6.QtMultimedia import QAudioOutput, QMediaCaptureSession, QMediaPlayer, QVideoFrame, QVideoSink, QWindowCapture
from presentation import Presentation, find_window
from web_course import WebCourseWindow
from source_metadata import web_identity, platform_for_url, clean_page_title
from ui_locale import ui_text

ROOT = Path(sys._MEIPASS) if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1]
STATE = Path(os.environ['VMA_STATE_DIR']) if os.environ.get('VMA_STATE_DIR') else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'VideoMemoryAssistant' if getattr(sys, 'frozen', False) else ROOT / '.desktop-state'
PREVIEW_TICKET = secrets.token_urlsafe(24)


def result(**values):
    return json.dumps(values, ensure_ascii=False)


def normalize_web_url(value):
    value = value.strip()
    if '://' not in value:
        value = 'https://' + value
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or any(character.isspace() for character in value):
            raise ValueError()
        return urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path or '/', parsed.query, parsed.fragment))
    except ValueError:
        raise ValueError('请填写 http 或 https 课程网址，不要在网址中包含账号密码。') from None


class NativeBridge(QObject):
    changed = Signal(str, object)

    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self.ui_language = 'zh-CN'
        self.capturable = {}
        self.latest = {}
        self.preview_frame = (0, b'')
        self.latest_frame = QVideoFrame()
        self.latest_frame_stamp = 0
        self.latest_frame_time = 0
        self.mode = None
        self.current_source = None
        self.capture_error = ''
        self.media_error = ''
        self.capture = QWindowCapture(self)
        self.capture_session = QMediaCaptureSession(self)
        self.capture_session.setWindowCapture(self.capture)
        self.sink = QVideoSink(self)
        self.capture_session.setVideoSink(self.sink)
        self.sink.videoFrameChanged.connect(lambda frame: self.accept_frame(frame) if self.mode == 'window' else None)
        self.capture.errorOccurred.connect(lambda _code, text: setattr(self, 'capture_error', text))
        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setAudioOutput(self.audio)
        self.media_sink = QVideoSink(self)
        self.player.setVideoSink(self.media_sink)
        self.media_sink.videoFrameChanged.connect(lambda frame: self.accept_frame(frame) if self.mode == 'local' else None)
        self.player.errorOccurred.connect(lambda _code, text: setattr(self, 'media_error', text))
        mapping = STATE / 'local-files.json'
        self.files = json.loads(mapping.read_text(encoding='utf-8')) if mapping.exists() else {}
        web_mapping = STATE / 'web-sources.json'
        self.web_sources = json.loads(web_mapping.read_text(encoding='utf-8')) if web_mapping.exists() else {}
        self.browser_paths = {'default': None}
        self.target_window = None
        self.presentation = Presentation(window, self)
        self.web_window = None
        self.web_entry = None
        self.web_attach_pending = False

    def notify(self, name, detail):
        self.changed.emit(name, detail)

    def ui_text(self, text): return ui_text(text, self.ui_language)

    @Slot(str, result=str)
    def setUiLanguage(self, language):
        if language not in ('zh-CN', 'zh-TW', 'en'): return result(error='Unsupported interface language')
        self.ui_language = language
        self.window.setWindowTitle(self.ui_text('Vidence · 学习空间'))
        if self.presentation.player: self.presentation.player.retranslate()
        if self.web_window: self.web_window.setWindowTitle(self.ui_text('课程播放 · Vidence'))
        return result(ok=True)

    def accept_frame(self, frame):
        if not frame.isValid(): return
        # 共享一帧引用，不把播放帧逐张读回CPU或编码。原生控件直接渲染视频。
        self.latest_frame = QVideoFrame(frame)
        self.latest_frame_stamp = time.time_ns()
        self.latest_frame_time = frame.startTime() / 1000000 if frame.startTime() >= 0 else self.player.position() / 1000
        if self.mode == 'window': self.capture_error = ''

    def encode_preview(self):
        if not self.latest_frame.isValid() or self.latest_frame_stamp == self.preview_frame[0]: return
        image = self.latest_frame.toImage()
        if image.isNull(): return
        image = image.scaledToWidth(min(1280, image.width()), Qt.TransformationMode.SmoothTransformation)
        buffer = QBuffer(); buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        image.save(buffer, 'JPEG', 86)
        self.preview_frame = (self.latest_frame_stamp, bytes(buffer.data()))
        self.latest = {'capturedAt': self.latest_frame_stamp // 1000000, 'previewUrl': f'/preview/{PREVIEW_TICKET}'}

    @Slot(int, result=str)
    def keyframe(self, max_width):
        if not self.latest_frame.isValid(): return result(error='画面尚未就绪')
        max_width = max(320, min(3840, max_width))
        image = self.latest_frame.toImage()
        if image.isNull(): return result(error='无法读取当前画面')
        if image.width() > max_width:
            image = image.scaledToWidth(max_width, Qt.TransformationMode.SmoothTransformation)
        buffer = QBuffer(); buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        image.save(buffer, 'JPEG', 94)
        return result(dataUrl='data:image/jpeg;base64,' + base64.b64encode(bytes(buffer.data())).decode('ascii'), width=image.width(), height=image.height(), mediaTime=self.latest_frame_time if self.mode == 'local' else 0, capturedAt=self.latest_frame_stamp // 1000000, origin='canvas', sourceId=self.current_source['id'] if self.current_source else None)

    @Slot(result=str)
    def bootstrap(self):
        default_state = STATE / 'agent' if getattr(sys, 'frozen', False) else ROOT / '.local-agent'
        token_path = Path(os.environ.get('VMA_PAIRING_FILE', str(default_state / 'token')))
        token_path.parent.mkdir(parents=True, exist_ok=True)
        if not token_path.exists():
            token_path.write_text(secrets.token_hex(32), encoding='utf-8')
        token = token_path.read_text(encoding='utf-8').strip()
        bridge_responded = False
        def healthy():
            nonlocal bridge_responded
            request = urllib.request.Request('http://127.0.0.1:8131/health', headers={'Authorization': f'Bearer {token}'})
            try:
                with urllib.request.urlopen(request, timeout=.6) as response:
                    bridge_responded = True
                    return response.status == 200
            except urllib.error.HTTPError:
                bridge_responded = True
                return False
            except Exception:
                return False
        if healthy():return result(token=token)
        if bridge_responded:return result(error='已有其他配对的智能体服务正在运行。请在设置中展开“连接已有服务”，选择它的配对文件或填写连接令牌。',existingBridge=True)
        node = ROOT / ('runtime/node.exe' if os.name == 'nt' else 'runtime/node')
        executable = str(node) if node.exists() else shutil.which('node')
        if not executable:return result(error='本机智能体服务尚未准备好；也可以在设置中选择 API Key。')
        env = dict(os.environ, VMA_AGENT_STATE=str(token_path.parent))
        with (token_path.parent/'bridge.log').open('ab') as log:
            subprocess.Popen([executable, str(ROOT / 'scripts/local-agent-bridge.mjs')], cwd=ROOT, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        for _ in range(30):
            if healthy():return result(token=token)
            if bridge_responded:return result(error='已有智能体服务使用不同配对，请从设置连接已有服务。',existingBridge=True)
            time.sleep(.1)
        return result(error='本机智能体服务未能启动，请重试连接；API Key 路线仍可使用。')

    @Slot(result=str)
    def currentSource(self):
        return json.dumps(self.current_source)

    @Slot(result=str)
    def browsers(self):
        choices = [{'id': 'in-app', 'title': self.ui_text('应用内播放（支持网页全屏）')}, {'id': 'default', 'title': self.ui_text('系统默认浏览器')}]
        self.browser_paths = {'default': None, 'in-app': None}
        if os.name == 'nt':
            import winreg
            for executable, title in [('msedge.exe', 'Microsoft Edge'), ('chrome.exe', 'Google Chrome'), ('firefox.exe', 'Firefox'), ('brave.exe', 'Brave'), ('opera.exe', 'Opera'), ('QQBrowser.exe', 'QQ 浏览器'), ('360chrome.exe', '360 极速浏览器'), ('360se.exe', '360 安全浏览器')]:
                found = None
                for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                        try:
                            with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths' + chr(92) + executable, 0, winreg.KEY_READ | view) as key:
                                candidate = winreg.QueryValue(key, None).strip('"')
                                if Path(candidate).is_file(): found = candidate
                        except OSError:
                            pass
                if found:
                    self.browser_paths[executable] = found
                    choices.append({'id': executable, 'title': title})
        return json.dumps(choices, ensure_ascii=False)

    def launch_web(self, address, browser):
        if browser == 'in-app':
            if self.web_window is not None and not self.web_window.opened:
                self.web_window.deleteLater(); self.web_window = None
            if self.web_window is None: self.web_window = WebCourseWindow(self, STATE)
            if self.presentation.target or self.presentation.docked: self.presentation.restore('source-changed')
            self.web_attach_pending = True
            self.web_navigated(address)
            self.web_window.open(address)
            QTimer.singleShot(200, self.capture_web)
            return
        if browser not in self.browser_paths:
            raise ValueError('这个浏览器已不可用，请重新选择。')
        executable = self.browser_paths[browser]
        if executable:
            subprocess.Popen([executable, address], creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        elif not QDesktopServices.openUrl(QUrl(address)):
            raise ValueError('浏览器没有打开，请检查系统默认浏览器设置。')

    @Slot(str, str, result=str)
    def openWebPage(self, address, browser):
        try:
            address = normalize_web_url(address)
            identifier = secrets.token_urlsafe(18)
            self.web_sources[identifier] = {'address': address, 'browser': browser}
            STATE.mkdir(parents=True, exist_ok=True)
            pending = STATE / 'web-sources.tmp'
            pending.write_text(json.dumps(self.web_sources, ensure_ascii=False), encoding='utf-8')
            pending.replace(STATE / 'web-sources.json')
            self.web_entry = identifier if browser == 'in-app' else None
            self.launch_web(address, browser)
            # 原始地址只留在本设备；公开记录不携带网址中的票据或其他参数。
            return result(url=f'vma-web://lesson/{identifier}', inApp=browser == 'in-app')
        except (ValueError, OSError) as error:
            return result(error=str(error))

    @Slot(result=str)
    def windows(self):
        candidates = QWindowCapture.capturableWindows()
        own_titles = [self.window.windowTitle()] + ([self.presentation.player.windowTitle()] if self.presentation.player else [])
        self.capturable = {secrets.token_urlsafe(12): candidate for candidate in candidates if candidate.isValid() and candidate.description() not in own_titles}
        return json.dumps([{'id': key, 'title': candidate.description()} for key, candidate in self.capturable.items()], ensure_ascii=False)

    @Slot(str, result=str)
    def captureWindow(self, identifier):
        candidate = self.capturable.get(identifier)
        if candidate is None or not candidate.isValid():
            return result(error='这个窗口已经关闭，请刷新窗口列表。')
        if self.presentation.target or self.presentation.docked: self.presentation.restore('source-changed')
        if self.presentation.player: self.presentation.player.hide()
        self.target_window = find_window(candidate.description())
        self.player.pause()
        self.capture.stop()
        self.mode = 'window'
        self.current_source = None
        self.latest = {}
        self.preview_frame = (0, b'')
        self.latest_frame = QVideoFrame()
        self.latest_frame_stamp = 0
        self.latest_frame_time = 0
        self.capture_error = ''
        self.capture.setWindow(candidate)
        self.capture.start()
        return result(ok=True)

    @Slot(result=str)
    def stopCapture(self):
        self.capture.stop()
        self.player.pause()
        if self.web_window and self.target_window == int(self.web_window.winId()): self.web_window.pause_videos()
        return result(ok=True)

    @Slot(result=str)
    def resumeCapture(self):
        if self.mode != 'window':
            return result(error='请先选择课程窗口。')
        self.capture.start()
        return result(ok=True)

    def load_video(self, file):
        file = Path(file).resolve()
        if not file.is_file():
            return result(error='视频文件已移动或删除，请重新选择。')
        if self.presentation.target or self.presentation.docked: self.presentation.restore('source-changed')
        self.target_window = None
        identity = f'{file}|{file.stat().st_size}|{file.stat().st_mtime_ns}'
        identifier = 'local_' + hashlib.sha256(identity.encode('utf-8')).hexdigest()[:24]
        self.files[identifier] = str(file)
        STATE.mkdir(parents=True, exist_ok=True)
        (STATE / 'local-files.json').write_text(json.dumps(self.files, ensure_ascii=False), encoding='utf-8')
        self.capture.stop()
        self.mode = 'local'
        self.latest = {}
        self.preview_frame = (0, b'')
        self.latest_frame = QVideoFrame()
        self.latest_frame_stamp = 0
        self.latest_frame_time = 0
        self.media_error = ''
        self.player.setSource(QUrl.fromLocalFile(str(file)))
        self.player.play()
        self.current_source = {'id': identifier, 'title': file.stem, 'url': f'vma-local://video/{identifier}', 'kind': 'local'}
        return json.dumps(self.current_source, ensure_ascii=False)

    @Slot(result=str)
    def openVideo(self):
        file, _ = QFileDialog.getOpenFileName(self.window, self.ui_text('选择视频'), '', 'Video (*.mp4 *.m4v *.mkv *.mov *.webm *.avi);;All files (*)')
        if not file: return result(canceled=True)
        source = self.load_video(file)
        if not json.loads(source).get('error'): QTimer.singleShot(0, self.presentation.attach)
        return source

    @Slot(str, float, result=str)
    def media(self, action, value):
        if action == 'play':
            self.player.play()
        elif action == 'pause':
            self.player.pause()
        elif action == 'seek':
            self.player.setPosition(int(max(0, min(value * 1000, self.player.duration()))))
        elif action == 'volume':
            self.audio.setVolume(max(0, min(1, value)))
        else:
            return result(error='未知的播放操作')
        return result(ok=True)

    @Slot(result=str)
    def frame(self):
        error = self.media_error if self.mode == 'local' else self.capture_error
        if error:
            return result(error=f'无法取得所选画面：{error}')
        self.encode_preview()
        data = dict(self.latest)
        if self.mode == 'window' and self.capture.isActive() and data and time.time() * 1000 - data['capturedAt'] > 8000:
            return result(error='所选窗口没有更新画面，请确认课程窗口仍可见并在播放。')
        if self.preview_frame[1]:
            data['dataUrl'] = 'data:image/jpeg;base64,' + base64.b64encode(self.preview_frame[1]).decode('ascii')
        data.update(time=self.latest_frame_time if self.mode == 'local' else 0, duration=self.player.duration() / 1000 if self.mode == 'local' else 0, capturing=self.capture.isActive())
        if self.current_source: data['sourceId'] = self.current_source['id']
        if self.mode == 'local': data['playing'] = self.player.isPlaying()
        return json.dumps(data)

    @Slot(str, float, result=str)
    def openSource(self, source, seconds):
        parsed = urlsplit(source)
        if parsed.scheme == 'vma-web':
            identifier = parsed.path.strip('/')
            entry = self.web_sources.get(identifier)
            if not entry:
                return result(error='这个网页课程尚未在本设备关联，请重新填写原网址。')
            address = urlsplit(entry['address'])
            if (address.hostname or '').endswith(('youtube.com', 'youtu.be', 'bilibili.com')):
                query = [(key, value) for key, value in parse_qsl(address.query, keep_blank_values=True) if key != 't']
                address = address._replace(query=urlencode(query + [('t', str(max(0, int(seconds))))]))
            try:
                if entry['browser'] not in self.browser_paths: self.browsers()
                self.web_entry = identifier if entry['browser'] == 'in-app' else None
                self.launch_web(urlunsplit(address), entry['browser'])
                return result(ok=True, source=self.current_source) if entry['browser'] == 'in-app' else result(ok=True)
            except (ValueError, OSError) as error:
                return result(error=str(error))
        if parsed.scheme == 'vma-local':
            identifier = parsed.path.strip('/')
            file = self.files.get(identifier)
            if not file:
                return result(error='这个本地视频尚未关联，请重新选择原文件。')
            if self.mode != 'local' or self.player.source().toLocalFile() != file:
                self.load_video(file)
                # 等媒体加载后定位，不把 seek 发送给尚未准备好的新播放器。
                self.pending_seek = seconds
                self.player.mediaStatusChanged.connect(self.seek_when_loaded)
            else:
                self.player.setPosition(int(max(0, seconds) * 1000))
            self.player.play()
            self.presentation.attach()
            return result(ok=True, source=self.current_source)
        if parsed.scheme == 'vma-course':
            QMessageBox.information(self.window, '回到课程', '请返回原课程客户端。这个来源记录的是采集时间，不能自动定位视频进度。')
            return result(ok=True)
        if parsed.scheme in ('http', 'https'):
            QDesktopServices.openUrl(QUrl(source))
            return result(ok=True)
        return result(error='不支持这个视频来源')

    def seek_when_loaded(self, status):
        if status == QMediaPlayer.MediaStatus.LoadedMedia and hasattr(self, 'pending_seek'):
            self.player.setPosition(int(max(0, self.pending_seek) * 1000))
            del self.pending_seek
            self.player.mediaStatusChanged.disconnect(self.seek_when_loaded)

    @Slot(result=str)
    def presentationState(self): return result(**self.presentation.state())

    @Slot(result=str)
    def attachSidebar(self):
        try: return result(**self.presentation.attach())
        except ValueError as error: return result(error=str(error))

    @Slot(bool, result=str)
    def collapseSidebar(self, collapsed): return result(**self.presentation.collapse(collapsed))

    @Slot(result=str)
    def hideSidebar(self):return result(**self.presentation.hide_sidebar())

    @Slot(result=str)
    def showSidebar(self):return result(**self.presentation.show_sidebar())

    @Slot(result=str)
    def restoreWindow(self): return result(**self.presentation.restore())

    @Slot(bool, result=str)
    def fullscreen(self, enabled):
        try: return result(**self.presentation.fullscreen(enabled))
        except ValueError as error: return result(error=str(error))

    @Slot(bool, result=str)
    def playerFullscreen(self, enabled):
        if self.presentation.player is None: return result(error='请先打开独立播放器')
        self.presentation.player.set_fullscreen(enabled)
        return result(**self.presentation.state())

    @Slot(result=str)
    def closeWebCourse(self):
        if self.web_window:
            self.web_window.close()
        return result(ok=True)

    def web_navigated(self, address):
        if not self.web_entry or not address.startswith(('http://', 'https://')): return
        previous = self.web_sources[self.web_entry]['address']
        identity = web_identity
        if self.current_source and self.current_source.get('url') == f'vma-web://lesson/{self.web_entry}' and identity(previous) == identity(address): return
        self.capture.stop()
        if identity(previous) != identity(address):
            self.web_entry = secrets.token_urlsafe(18)
            self.web_sources[self.web_entry] = {'address': address, 'browser': 'in-app'}
        else: self.web_sources[self.web_entry]['address'] = address
        STATE.mkdir(parents=True, exist_ok=True)
        (STATE / 'web-sources.json').write_text(json.dumps(self.web_sources, ensure_ascii=False), encoding='utf8')
        source = {'id': 'web_' + hashlib.sha256(repr(identity(address)).encode()).hexdigest()[:24], 'url': f'vma-web://lesson/{self.web_entry}', 'title': urlsplit(address).hostname or '网页课程', 'kind': 'window', 'platform': platform_for_url(address)}
        self.current_source = source
        self.latest = {}; self.preview_frame = (0, b'')
        self.notify('desktop:source-changed', source)
        QTimer.singleShot(200, self.capture_web)

    def web_title_changed(self, title, address):
        if not self.web_entry or not self.current_source or self.current_source.get('url') != f'vma-web://lesson/{self.web_entry}': return
        if web_identity(address) != web_identity(self.web_sources[self.web_entry]['address']): return
        title = clean_page_title(title)
        if not title or title == self.current_source['title']: return
        previous = self.current_source['title']
        self.current_source.update(title=title, platform=platform_for_url(address))
        self.notify('desktop:source-title', {**self.current_source, 'previousTitle': previous})

    def capture_web(self, attempts=0):
        if not self.web_window or not self.web_window.isVisible(): return
        candidates = [candidate for candidate in QWindowCapture.capturableWindows() if candidate.description() == self.web_window.windowTitle()]
        if not candidates:
            if attempts < 20: QTimer.singleShot(100, lambda: self.capture_web(attempts + 1))
            return
        handle = int(self.web_window.winId())
        if not self.capture.isActive() or getattr(self, 'captured_web_handle', None) != handle or self.mode != 'window':
            self.player.pause(); self.capture.stop(); self.mode = 'window'; self.capture_error = ''
            self.target_window = handle; self.captured_web_handle = handle
            self.capture.setWindow(candidates[0]); self.capture.start()
        if self.web_attach_pending:
            self.web_attach_pending = False
            self.presentation.attach(self.target_window)
