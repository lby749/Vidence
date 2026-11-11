"""使用 Qt 原生 WebView：Windows WebView2 / macOS WKWebView，所有网页控件可直接交互。"""
import json
import os
import ctypes
from ctypes import wintypes
from PySide6.QtCore import QTimer, QUrl
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import QMainWindow, QWidget
from PySide6.QtWebView import QWebView, QWebViewLoadingInfo, QWebViewSettings


class WebCourseWindow(QMainWindow):
    def __init__(self, bridge, _state):
        super().__init__()
        self.bridge = bridge
        self.before_fullscreen_collapsed = False
        self.dom_fullscreen = False
        self.opened = False
        self.setWindowTitle(bridge.ui_text('课程播放 · Vidence'))
        self.resize(1160, 780)
        self.view = QWebView()
        self.view.settings().setAttribute(QWebViewSettings.WebAttribute.AllowFileAccess, False)
        self.view.settings().setAttribute(QWebViewSettings.WebAttribute.LocalContentCanAccessFileUrls, False)
        self.setCentralWidget(QWidget.createWindowContainer(self.view, self))
        self.view.urlChanged.connect(lambda url: bridge.web_navigated(url.toString()))
        self.view.titleChanged.connect(self.update_title)
        self.view.loadingChanged.connect(self.loaded)
        self.timer = QTimer(self); self.timer.setInterval(200); self.timer.timeout.connect(self.poll_fullscreen)
        # WebView2 的子进程拿到键盘焦点时 Qt 快捷键收不到 Esc。
        # 只在本课程处于前台全屏时检查按键，避免影响其他应用。
        self.escape_timer = QTimer(self); self.escape_timer.setInterval(40); self.escape_timer.timeout.connect(self.check_escape)
        QShortcut(QKeySequence('Esc'), self, activated=self.exit_fullscreen)
        QShortcut(QKeySequence('F11'), self, activated=lambda: self.exit_fullscreen() if self.isFullScreen() else self.showFullScreen())

    def loaded(self, info):
        if info.status() == QWebViewLoadingInfo.LoadStatus.Failed:
            self.bridge.notify('desktop:playback-error', info.errorString())
        elif info.status() == QWebViewLoadingInfo.LoadStatus.Succeeded:
            self.update_title()
            self.bridge.capture_web()

    def update_title(self):
        if not self.opened: return
        def received(raw):
            try: info = json.loads(raw) if isinstance(raw, str) else raw
            except (ValueError, TypeError): return
            if isinstance(info, dict): self.bridge.web_title_changed(info.get('title'), info.get('address', ''))
        self.view.runJavaScript("JSON.stringify({address:location.href,title:document.title||document.querySelector('meta[property=\"og:title\"]')?.content||document.querySelector('h1')?.textContent})", received)

    def open(self, address):
        self.opened = True
        self.view.setUrl(QUrl(address)); self.show(); self.raise_(); self.activateWindow(); self.timer.start()

    def poll_fullscreen(self):
        if self.isVisible(): self.view.runJavaScript('JSON.stringify(!!document.fullscreenElement)', self.fullscreen_state)

    def fullscreen_state(self, raw):
        if not self.opened: return
        try: enabled = json.loads(raw) if isinstance(raw, str) else bool(raw)
        except (ValueError, TypeError): return
        if enabled == self.dom_fullscreen: return
        self.dom_fullscreen = enabled
        if enabled:
            self.before_fullscreen_collapsed = self.bridge.presentation.collapsed
            self.showFullScreen(); self.bridge.presentation.collapse(True)
            self.escape_timer.start()
        else:
            self.showNormal(); self.bridge.presentation.collapse(self.before_fullscreen_collapsed)
            self.escape_timer.stop()

    def check_escape(self):
        if os.name != 'nt' or not self.isFullScreen(): return
        api = ctypes.windll.user32
        api.GetForegroundWindow.restype = wintypes.HWND
        api.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]; api.GetAncestor.restype = wintypes.HWND
        foreground = api.GetForegroundWindow()
        if foreground == int(self.bridge.window.winId()): return
        if (foreground == int(self.winId()) or api.GetAncestor(foreground, 3) == int(self.winId())) and api.GetAsyncKeyState(0x1B) & 0x8001:
            self.exit_fullscreen()

    def exit_fullscreen(self):
        self.escape_timer.stop()
        self.view.runJavaScript('if(document.fullscreenElement)document.exitFullscreen().catch(()=>{})', lambda _raw: None)
        self.dom_fullscreen = False
        self.showNormal(); self.bridge.presentation.collapse(self.before_fullscreen_collapsed)

    def pause_videos(self): self.view.runJavaScript("document.querySelectorAll('video,audio').forEach(media=>media.pause())", lambda _raw: None)

    def closeEvent(self, event):
        self.opened = False; self.dom_fullscreen = False
        self.timer.stop(); self.escape_timer.stop(); self.view.setUrl(QUrl('about:blank'))
        self.bridge.capture.stop()
        if self.bridge.presentation.target == int(self.winId()): self.bridge.presentation.restore('player-closed')
        event.accept()
