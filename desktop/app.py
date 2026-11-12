"""Vidence原生桌面入口。界面与侧栏使用Qt Widgets，视频直接由Qt播放。"""
import json
import os
import sys
from PySide6.QtCore import QLockFile, QTimer
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication, QMainWindow, QMessageBox
from native_media import ROOT, STATE, NativeBridge, normalize_web_url
from native_store import NativeStore
from native_ui import NativeSidebar, STYLE
from local_models import LocalModels


class LearningWindow(QMainWindow):
    def closeEvent(self, event):
        self.sidebar.shutdown()
        if self.native.presentation.player:self.native.presentation.player.closing=True; self.native.presentation.player.controls.hide()
        self.native.capture.stop(); self.native.player.stop(); self.native.presentation.timer.stop()
        if self.native.web_window: self.native.web_window.close()
        self.models.unload()
        QApplication.quit(); event.accept()

    def changeEvent(self,event):
        super().changeEvent(event)
        if hasattr(self,'native') and not self.isMinimized() and not self.native.presentation.docked:self.native.presentation.hidden=False


def main():
    if os.name == 'nt':
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('Vidence.Desktop')
    # 系统WebView仅承载主动打开的课程网页，不承载主界面或学习栏。
    if os.name == 'nt': os.environ['QT_WEBVIEW_PLUGIN'] = 'webview2'
    os.environ['WEBVIEW2_USER_DATA_FOLDER'] = str(STATE/'course-native-profile')
    from PySide6.QtWebView import QtWebView
    QtWebView.initialize()
    app = QApplication(sys.argv); app.setApplicationName('Vidence'); app.setQuitOnLastWindowClosed(False)
    app.setWindowIcon(QIcon(str(ROOT/'public/brand/app.ico'))); app.setStyleSheet(STYLE)
    STATE.mkdir(parents=True,exist_ok=True)
    lock=QLockFile(str(STATE/'native-desktop.lock'))
    if not lock.tryLock(100):
        from launcher import focus_app
        if not focus_app(): QMessageBox.information(None,'Vidence','Vidence 已运行。请从任务栏回到学习窗口。')
        return 0
    window=LearningWindow(); window.setWindowTitle('Vidence · 学习空间'); window.resize(450,860)
    window.models=LocalModels(ROOT,STATE)
    window.native=NativeBridge(window)
    window.sidebar=NativeSidebar(window,window.native,NativeStore(STATE/'learning.sqlite'),window.models)
    window.setCentralWidget(window.sidebar); window.show()
    if '--video' in sys.argv:
        file=sys.argv[sys.argv.index('--video')+1]
        def open_video():
            source=json.loads(window.native.load_video(file)); window.sidebar.select_source(source)
            if not source.get('error'): window.native.presentation.attach()
        QTimer.singleShot(0,open_video)
    if '--mute' in sys.argv: window.native.audio.setMuted(True)
    code=app.exec(); lock.unlock(); return code


if __name__=='__main__':raise SystemExit(main())
