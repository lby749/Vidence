"""同一个学习侧栏在主窗口与播放器旁切换，不启动第二套网页/数据库。"""
import ctypes
from ctypes import wintypes
import os
from PySide6.QtCore import QObject, QRect, Qt, QTimer, QEvent
from PySide6.QtGui import QShortcut, QKeySequence
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import QApplication, QWidget, QMainWindow, QPushButton, QSlider, QLabel, QHBoxLayout, QVBoxLayout, QStackedLayout


def find_window(title):
    # Qt 的 Python QCapturableWindow 不公开原生句柄；只在标题唯一时绑定，
    # 同名时拒绝自动挂靠，避免侧栏跟错另一个课程窗口。
    if os.name != 'nt': return None
    api = ctypes.windll.user32
    api.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    api.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    found = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(handle, _parameter):
        text = ctypes.create_unicode_buffer(api.GetWindowTextLengthW(handle) + 1)
        api.GetWindowTextW(handle, text, len(text))
        if text.value == title: found.append(int(handle))
        return True
    callback = callback_type(visit)
    api.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    api.EnumWindows(callback, 0)
    return found[0] if len(found) == 1 else None


def window_bounds(identifier):
    if os.name != 'nt': return None
    api = ctypes.windll.user32
    api.IsWindow.argtypes = [wintypes.HWND]
    api.IsIconic.argtypes = [wintypes.HWND]
    api.IsWindowVisible.argtypes = [wintypes.HWND]
    api.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    if not api.IsWindow(identifier): return False
    if api.IsIconic(identifier) or not api.IsWindowVisible(identifier): return None
    rect = wintypes.RECT()
    if not api.GetWindowRect(identifier, ctypes.byref(rect)): return None
    class MonitorInfo(ctypes.Structure):
        _fields_ = [('cbSize', wintypes.DWORD), ('rcMonitor', wintypes.RECT), ('rcWork', wintypes.RECT), ('dwFlags', wintypes.DWORD), ('szDevice', wintypes.WCHAR * 32)]
    api.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    api.MonitorFromWindow.restype = wintypes.HMONITOR
    api.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MonitorInfo)]
    info = MonitorInfo(); info.cbSize = ctypes.sizeof(info)
    api.GetMonitorInfoW(api.MonitorFromWindow(identifier, 2), ctypes.byref(info))
    screen = next((screen for screen in QApplication.screens() if screen.name() == info.szDevice), QApplication.primaryScreen())
    ratio = screen.devicePixelRatio()
    return QRect(round(screen.geometry().x() + (rect.left - info.rcMonitor.left) / ratio), round(screen.geometry().y() + (rect.top - info.rcMonitor.top) / ratio), round((rect.right - rect.left) / ratio), round((rect.bottom - rect.top) / ratio))


class PlayerWindow(QMainWindow):
    def __init__(self, controller, bridge):
        super().__init__()
        self.controller, self.bridge = controller, bridge
        self.before_fullscreen_collapsed = False
        self.setWindowTitle(bridge.ui_text('视频播放 · Vidence'))
        self.resize(1100, 720)
        self.surface = QVideoWidget()
        self.surface.setMinimumSize(320, 180)
        bridge.player.setVideoOutput(self.surface)
        self.surface.videoSink().videoFrameChanged.connect(lambda frame: bridge.accept_frame(frame) if bridge.mode == 'local' else None)
        self.play = QPushButton('暂停')
        self.play.setAccessibleName('播放或暂停')
        self.play.clicked.connect(lambda: bridge.player.pause() if bridge.player.isPlaying() else bridge.player.play())
        self.seek = QSlider(Qt.Orientation.Horizontal)
        self.seek.setAccessibleName('视频进度')
        self.seek.setSingleStep(5000); self.seek.setPageStep(30000)
        self.seek.sliderMoved.connect(bridge.player.setPosition)
        self.seek.sliderReleased.connect(lambda: bridge.player.setPosition(self.seek.value()))
        self.seek.actionTriggered.connect(lambda _action: bridge.player.setPosition(self.seek.sliderPosition()))
        self.clock = QLabel('00:00 / 00:00')
        self.volume = QSlider(Qt.Orientation.Horizontal)
        self.volume.setAccessibleName('音量'); self.volume.setRange(0, 100); self.volume.setValue(round(bridge.audio.volume() * 100)); self.volume.setFixedWidth(88)
        self.volume.valueChanged.connect(lambda value: bridge.audio.setVolume(value / 100))
        bridge.audio.volumeChanged.connect(lambda value: self.volume.setValue(round(value * 100)))
        self.mute = QPushButton('静音')
        self.mute.clicked.connect(lambda: bridge.audio.setMuted(not bridge.audio.isMuted()))
        self.fullscreen_button = QPushButton('全屏')
        self.fullscreen_button.clicked.connect(self.toggle_fullscreen)
        self.sidebar = QPushButton(bridge.ui_text('学习侧栏'))
        self.sidebar.clicked.connect(lambda: controller.collapse(not controller.collapsed) if controller.docked or controller.target == int(self.winId()) else controller.attach(int(self.winId())))
        bar = QHBoxLayout()
        for widget in [self.play, self.seek, self.clock, self.mute, self.volume, self.sidebar, self.fullscreen_button]: bar.addWidget(widget)
        self.controls = QWidget(); self.controls.setObjectName('playbackControls'); self.controls.setLayout(bar)
        # 控件浮在视频底部，不挤占全屏画面；容器空白区域不拦截视频点击。
        overlay = QWidget(); overlay_layout = QVBoxLayout(overlay); overlay_layout.setContentsMargins(16, 0, 16, 16); overlay_layout.addStretch(); overlay_layout.addWidget(self.controls)
        layout = QStackedLayout(); layout.setStackingMode(QStackedLayout.StackingMode.StackAll); layout.addWidget(self.surface); layout.addWidget(overlay); layout.setCurrentWidget(overlay)
        body = QWidget(); body.setLayout(layout); self.setCentralWidget(body)
        self.hide_controls = QTimer(self); self.hide_controls.setSingleShot(True); self.hide_controls.setInterval(2500); self.hide_controls.timeout.connect(self.autohide)
        for widget in [body, overlay, self.surface, self.controls, *self.controls.findChildren(QWidget)]:
            widget.setMouseTracking(True); widget.installEventFilter(self)
        self.setStyleSheet('QWidget { color:#f4f4f7; font-family:"Microsoft YaHei"; } QMainWindow {background:#0c0d10;} #playbackControls {background:rgba(24,26,32,230);border:1px solid #383b44;border-radius:16px;} QPushButton { background:transparent; border:0; border-radius:9px; padding:9px 12px; } QPushButton:hover {background:#3a3d48;} QSlider::groove:horizontal {height:4px;background:#454854;border-radius:2px;} QSlider::handle:horizontal {background:white;width:12px;margin:-4px 0;border-radius:6px;}')
        bridge.player.durationChanged.connect(lambda duration: self.seek.setMaximum(min(duration, 2147483647)))
        def position(value):
            if not self.seek.isSliderDown(): self.seek.setValue(value)
            seconds, duration = value // 1000, bridge.player.duration() // 1000
            self.clock.setText(f'{seconds // 60:02d}:{seconds % 60:02d} / {duration // 60:02d}:{duration % 60:02d}')
        bridge.player.positionChanged.connect(position)
        bridge.player.playbackStateChanged.connect(lambda _state: (self.retranslate(), self.reveal_controls()))
        bridge.audio.mutedChanged.connect(lambda _muted: self.retranslate())
        QShortcut(QKeySequence('F'), body, activated=self.toggle_fullscreen)
        QShortcut(QKeySequence('F11'), body, activated=self.toggle_fullscreen)
        QShortcut(QKeySequence('Esc'), body, activated=lambda: self.set_fullscreen(False) if self.host_window().isFullScreen() else None)
        QShortcut(QKeySequence('Space'), body, activated=self.play.click)
        self.retranslate()

    def retranslate(self):
        label = self.bridge.ui_text
        self.setWindowTitle(label('视频播放 · Vidence'))
        self.play.setText(label('暂停' if self.bridge.player.isPlaying() else '播放'))
        self.play.setAccessibleName(label('播放或暂停')); self.seek.setAccessibleName(label('视频进度')); self.volume.setAccessibleName(label('音量'))
        self.mute.setText(label('取消静音' if self.bridge.audio.isMuted() else '静音'))
        self.sidebar.setText(label('学习侧栏')); self.fullscreen_button.setText(label('退出全屏' if self.host_window().isFullScreen() else '全屏'))

    def host_window(self): return self.controller.window if self.controller.docked else self

    def eventFilter(self, watched, event):
        if event.type() in (QEvent.Type.MouseMove, QEvent.Type.MouseButtonPress): self.reveal_controls()
        if event.type() == QEvent.Type.MouseButtonDblClick and watched not in [self.controls, *self.controls.findChildren(QWidget)]: self.toggle_fullscreen(); return True
        return super().eventFilter(watched, event)

    def reveal_controls(self):
        self.controls.show(); self.hide_controls.start()

    def autohide(self):
        if self.host_window().isFullScreen() and self.bridge.player.isPlaying() and not self.controls.underMouse(): self.controls.hide()

    def set_fullscreen(self, enabled):
        host = self.host_window()
        if enabled == host.isFullScreen(): return
        if enabled:
            self.before_fullscreen_collapsed = self.controller.collapsed
            host.showFullScreen(); self.controller.collapse(True)
        else:
            host.showNormal(); self.controller.collapse(self.before_fullscreen_collapsed)
        self.retranslate()
        self.reveal_controls(); self.controller.follow(); self.controller.emit()

    def toggle_fullscreen(self):
        self.set_fullscreen(not self.host_window().isFullScreen())

    def closeEvent(self, event):
        self.bridge.stopCapture()
        if self.controller.target == int(self.winId()): self.controller.restore('player-closed')
        event.accept()


class Presentation(QObject):
    def __init__(self, window, bridge):
        super().__init__(window)
        self.window, self.bridge = window, bridge
        self.target = None
        self.owner_window = None
        self.docked = False
        self.collapsed = False
        self.player = None
        self.saved_geometry = None
        self.saved_flags = window.windowFlags()
        self.saved_maximized = False
        self.timer = QTimer(self); self.timer.setInterval(200); self.timer.timeout.connect(self.follow)

    def state(self, reason=None):
        rect = self.window.geometry()
        web = self.bridge.web_window
        return {'attached': bool(self.target) or self.docked, 'docked': self.docked, 'collapsed': self.collapsed, 'fullscreen': self.window.isFullScreen(), 'visible': self.window.isVisible(), 'playerFullscreen': bool(self.player and self.player.host_window().isFullScreen()), 'webFullscreen': bool(web and web.isFullScreen()), 'playerVisible': bool(self.player and self.player.isVisible()), 'target': self.target, 'geometry': [rect.x(), rect.y(), rect.width(), rect.height()], 'reason': reason}

    def emit(self, reason=None): QTimer.singleShot(0, lambda: self.bridge.notify('desktop:presentation', self.state(reason)))

    def attach(self, target=None):
        if target is None:
            if self.bridge.mode == 'local':
                return self.dock()
            else: target = self.bridge.target_window
        if self.docked: self.restore()
        if not target: raise ValueError('这个窗口无法自动挂靠，可能有同名窗口。可以在应用内展开学习侧栏。')
        own_web = self.bridge.web_window is not None and target == int(self.bridge.web_window.winId())
        if os.name != 'nt' and not own_web and (self.player is None or target != int(self.player.winId())):
            raise ValueError('此系统可在独立播放器旁使用侧栏；外部课程窗口跟随尚未实现')
        if not self.target:
            self.saved_geometry = self.window.saveGeometry()
            self.saved_maximized = self.window.isMaximized()
            flags = Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint
            if not own_web: flags |= Qt.WindowType.WindowStaysOnTopHint
            self.window.setParent(self.bridge.web_window if own_web else None, flags)
            self.window.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.target, self.collapsed = target, False
        self.owner_window = self.bridge.web_window if own_web else None
        if self.player is not None and target == int(self.player.winId()): self.player.raise_(); self.player.activateWindow()
        elif own_web: self.bridge.web_window.raise_(); self.bridge.web_window.activateWindow()
        elif os.name == 'nt':
            ctypes.windll.user32.SetForegroundWindow.argtypes = [wintypes.HWND]
            ctypes.windll.user32.SetForegroundWindow(target)
        self.window.setMinimumSize(44, 100)
        self.window.show(); self.timer.start(); self.follow(); self.emit()
        return self.state()

    def dock(self):
        if self.target: self.restore()
        if self.player is None: self.player = PlayerWindow(self, self.bridge)
        if not self.docked:
            self.browser = self.window.takeCentralWidget()
            self.workspace = QWidget(self.window)
            layout = QHBoxLayout(self.workspace); layout.setContentsMargins(0, 0, 0, 0); layout.setSpacing(0)
            self.player.setParent(self.workspace, Qt.WindowType.Widget)
            layout.addWidget(self.player, 1); layout.addWidget(self.browser)
            self.window.setCentralWidget(self.workspace)
            self.docked = True; self.collapsed = False
        self.browser.setFixedWidth(48 if self.collapsed else 380)
        self.player.show(); self.window.show(); self.window.raise_(); self.window.activateWindow(); self.emit()
        return self.state()

    def follow(self):
        if not self.target: return
        own_player = self.player is not None and self.target == int(self.player.winId())
        own_window = self.owner_window or (self.player if own_player else None)
        if self.owner_window and self.target != int(self.owner_window.winId()):
            self.target = int(self.owner_window.winId()); self.bridge.target_window = self.target
            QTimer.singleShot(0, self.bridge.capture_web)
        target = own_window.frameGeometry() if own_window else window_bounds(self.target)
        if target is False:
            self.bridge.stopCapture(); self.restore('target-closed'); return
        if target is None or (own_window and own_window.isMinimized()): self.window.hide(); return
        visible = True
        if os.name == 'nt' and not own_window:
            api = ctypes.windll.user32; api.GetForegroundWindow.restype = wintypes.HWND
            visible = api.GetForegroundWindow() in [self.target, int(self.window.winId())]
        screen = QApplication.screenAt(target.center()) or QApplication.primaryScreen()
        area = screen.availableGeometry()
        width = 48 if self.collapsed else min(380, area.width())
        height = 116 if self.collapsed else min(max(400, target.height()), area.height() - 16)
        left = target.right() + 8
        if self.collapsed or left + width > area.right(): left = target.right() - width - 8
        left = max(area.left(), min(left, area.right() - width))
        top = target.center().y() - height // 2 if self.collapsed else target.top()
        top = max(area.top() + 8, min(top, area.bottom() - height - 8))
        geometry = QRect(left, top, width, height)
        if self.window.geometry() != geometry: self.window.setGeometry(geometry)
        if self.window.isVisible() != visible: self.window.setVisible(visible)

    def collapse(self, collapsed):
        self.collapsed = collapsed
        if self.docked: self.browser.setFixedWidth(48 if collapsed else 380)
        self.follow(); self.emit(); return self.state()

    def restore(self, reason=None):
        if self.docked:
            if self.window.isFullScreen(): self.player.set_fullscreen(False)
            workspace = self.window.takeCentralWidget()
            self.player.setParent(None, Qt.WindowType.Window); self.player.hide()
            self.browser.setParent(self.window); self.browser.setMinimumWidth(0); self.browser.setMaximumWidth(16777215)
            self.window.setCentralWidget(self.browser); workspace.deleteLater()
            self.docked = False; self.collapsed = False
            self.window.show(); self.window.activateWindow(); self.emit(reason); return self.state(reason)
        self.timer.stop(); self.target = None; self.owner_window = None
        self.window.setParent(None, self.saved_flags)
        self.window.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, False)
        if self.saved_geometry is not None: self.window.restoreGeometry(self.saved_geometry)
        self.window.showMaximized() if self.saved_maximized else self.window.showNormal()
        self.window.activateWindow(); self.emit(reason); return self.state(reason)

    def fullscreen(self, enabled):
        if self.bridge.mode == 'local':
            if not self.docked: self.attach()
            self.player.set_fullscreen(enabled)
            return self.state()
        if self.bridge.web_window and self.bridge.target_window == int(self.bridge.web_window.winId()):
            web = self.bridge.web_window
            if enabled: web.showFullScreen(); self.collapse(True)
            else: web.exit_fullscreen()
            self.emit(); return self.state()
        raise ValueError('请在原课程播放器中使用全屏按钮，或选择应用内打开课程')

