"""桌面启动器只启动原生应用。浏览器插件通过独立发行包安装。"""
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from PySide6.QtCore import QProcess, QTimer, QUrl, Qt
from PySide6.QtGui import QDesktopServices, QIcon, QPixmap
from PySide6.QtWidgets import QApplication, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget
from app_version import VERSION

FROZEN=getattr(sys,'frozen',False)
ROOT=Path(sys._MEIPASS) if FROZEN else Path(__file__).resolve().parents[1]
APP_DIR=Path(sys.executable).parent if FROZEN else ROOT/'dist/desktop-player/Vidence'
RELEASES='https://github.com/lby749/Vidence/releases'


@contextmanager
def system_library_paths():
    original_path=os.environ.get('PATH','')
    if FROZEN and os.name=='nt':
        ctypes.windll.kernel32.SetDllDirectoryW(None)
        os.environ['PATH']=os.pathsep.join(entry for entry in original_path.split(os.pathsep) if not Path(entry).is_relative_to(ROOT))
    try:yield
    finally:
        if FROZEN and os.name=='nt':
            os.environ['PATH']=original_path
            ctypes.windll.kernel32.SetDllDirectoryW(str(ROOT))


def focus_app():
    if os.name != 'nt': return False
    from ctypes import wintypes
    api = ctypes.windll.user32
    api.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    api.SetForegroundWindow.argtypes = [wintypes.HWND]
    api.IsIconic.argtypes = [wintypes.HWND]
    api.GetWindowTextLengthW.argtypes=[wintypes.HWND]; api.GetWindowTextW.argtypes=[wintypes.HWND,wintypes.LPWSTR,ctypes.c_int]
    api.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
    kernel=ctypes.windll.kernel32; kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]; kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]; kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    found=[]; callback_type=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    def visit(window,_parameter):
        title=ctypes.create_unicode_buffer(api.GetWindowTextLengthW(window)+1); api.GetWindowTextW(window,title,len(title))
        if title.value not in ('Vidence · 学习空间','Vidence · 學習空間','Vidence · Learning space'):return True
        if FROZEN:
            process_id=wintypes.DWORD(); api.GetWindowThreadProcessId(window,ctypes.byref(process_id)); process=kernel.OpenProcess(0x1000,False,process_id)
            if not process:return True
            path=ctypes.create_unicode_buffer(32768); length=wintypes.DWORD(len(path))
            try:matches=kernel.QueryFullProcessImageNameW(process,0,path,ctypes.byref(length)) and Path(path.value).resolve()==(APP_DIR/'Vidence.exe').resolve()
            finally:kernel.CloseHandle(process)
            if not matches:return True
        found.append(window); return False
    callback=callback_type(visit); api.EnumWindows.argtypes=[callback_type,wintypes.LPARAM]; api.EnumWindows(callback,0)
    if not found:return False
    window=found[0]
    if api.IsIconic(window):api.ShowWindow(window,9)
    api.SetForegroundWindow(window); return True



class Launcher(QWidget):
    def __init__(self,install=False):
        super().__init__(); self.setWindowTitle('Vidence'); self.resize(520,330)
        self.setStyleSheet('QWidget{background:#f8f9fc;color:#242833;font-family:"Segoe UI","Microsoft YaHei UI";font-size:14px;} QPushButton{background:white;border:1px solid #e1e5ed;border-radius:10px;padding:12px;} QPushButton#primary{background:#087bff;color:white;border:0;}')
        layout=QVBoxLayout(self); layout.setContentsMargins(32,30,32,30); layout.setSpacing(20)
        header=QHBoxLayout(); logo=QLabel(); logo.setPixmap(QPixmap(str(ROOT/'public/brand/icon-128.png')).scaled(36,36,Qt.AspectRatioMode.KeepAspectRatio,Qt.TransformationMode.SmoothTransformation)); header.addWidget(logo)
        title=QLabel('Vidence '+VERSION); title.setStyleSheet('font-size:23px;font-weight:600;'); header.addWidget(title); header.addStretch(); layout.addLayout(header)
        intro=QLabel('边看视频边提问，把学过的内容留下来。\n原生播放器与学习侧栏，无需安装开发工具。'); intro.setWordWrap(True); layout.addWidget(intro)
        self.open_button=QPushButton('打开 Vidence'); self.open_button.setObjectName('primary'); self.open_button.clicked.connect(self.open_app); layout.addWidget(self.open_button)
        extension=QPushButton('下载独立的浏览器插件'); extension.clicked.connect(lambda:QDesktopServices.openUrl(QUrl(RELEASES))); layout.addWidget(extension)
        self.status=QLabel('桌面应用与浏览器插件分开下载，按需要选择。'); self.status.setWordWrap(True); self.status.setStyleSheet('color:#798292;'); layout.addWidget(self.status)

    def open_app(self):
        if focus_app():self.close(); return
        executable=APP_DIR/'Vidence.exe'
        if not executable.is_file():self.status.setText('应用文件不完整，请重新解压整个桌面发行包。'); return
        started,_pid=QProcess.startDetached(str(executable),[],str(APP_DIR))
        if started:self.close()
        else:self.status.setText('启动失败，请检查应用文件是否被移动。')


def self_check(app,window,report_path):
    from PySide6.QtGui import QFontDatabase,QFont,QImage,QPainter
    from PySide6 import QtMultimedia,QtMultimediaWidgets
    from native_ui import NativeSidebar
    for name in ('segoeui.ttf','msyh.ttc'):
        file=Path(os.environ.get('WINDIR',r'C:\Windows'))/'Fonts'/name
        if file.is_file():QFontDatabase.addApplicationFont(str(file))
    assert (APP_DIR/'Vidence.exe').is_file()
    assert json.loads((ROOT/'build-info.json').read_text(encoding='utf8'))['version']==VERSION
    forbidden=[file.name for file in ROOT.rglob('*') if file.is_file() and ('webengine' in file.name.lower() or 'devtools_resources' in file.name.lower())]
    assert not forbidden,forbidden
    assert not (ROOT/'.output').exists(),'桌面包不应包含扩展构建'
    node=subprocess.run([str(ROOT/'runtime/node.exe'),'--version'],capture_output=True,text=True,check=True)
    window.show(); app.processEvents(); window.grab().save(str(report_path.with_suffix('.png')))
    import tempfile
    from PySide6.QtWidgets import QMainWindow
    from native_media import NativeBridge
    from native_store import NativeStore
    from local_models import LocalModels
    from native_ocr import recognize
    with tempfile.TemporaryDirectory(prefix='vidence-native-frozen-') as directory:
        store=NativeStore(Path(directory)/'test.sqlite'); store.set_setting('appUpdates',{'auto':False})
        native_window=QMainWindow(); native_window.resize(450,860); bridge=NativeBridge(native_window)
        original=NativeSidebar.bootstrap; NativeSidebar.bootstrap=lambda self:None
        try:sidebar=NativeSidebar(native_window,bridge,store,LocalModels(ROOT,Path(directory)))
        finally:NativeSidebar.bootstrap=original
        native_window.setCentralWidget(sidebar); native_window.show(); app.processEvents()
        assert sidebar.tabs.count()==5
        native_window.grab().save(str(report_path.with_name(report_path.stem+'-sidebar.png')))
        sidebar.shutdown(); bridge.player.stop(); bridge.capture.stop(); bridge.presentation.timer.stop(); native_window.hide()
    chart=QImage(1100,160,QImage.Format.Format_RGB32); chart.fill(Qt.GlobalColor.white)
    painter=QPainter(chart); painter.setPen(Qt.GlobalColor.black); painter.setFont(QFont('Arial',30)); painter.drawText(35,90,'Native desktop learning 2026'); painter.end()
    recognized=recognize(chart,'en-US')
    assert '2026' in recognized and 'learning' in recognized.lower(),recognized
    playback=None
    if '--media' in sys.argv:
        from PySide6.QtCore import QUrl
        from PySide6.QtMultimedia import QAudioOutput,QMediaPlayer,QVideoSink
        media=Path(sys.argv[sys.argv.index('--media')+1]).resolve(); assert media.is_file()
        player=QMediaPlayer(); audio=QAudioOutput(); audio.setMuted(True); sink=QVideoSink(); player.setAudioOutput(audio); player.setVideoSink(sink)
        samples=[]; sizes=set(); decoded=[0]
        def frame(value):
            if not value.isValid():return
            decoded[0]+=1; sizes.add((value.width(),value.height()))
            if decoded[0] in (1,90):
                image=value.toImage().scaled(64,36); assert not image.isNull(); samples.append(hashlib.sha256(bytes(image.constBits())).hexdigest())
        sink.videoFrameChanged.connect(frame); player.setSource(QUrl.fromLocalFile(str(media))); player.play()
        QTimer.singleShot(4000,app.quit); app.exec(); position=player.position(); error=player.errorString(); player.stop()
        assert not error and position>=2500 and decoded[0]>=90 and len(set(samples))==2,(position,decoded[0],error)
        playback={'passed':True,'scope':'frozen-qt-h264-decode-not-screen-present-rate','decodedFrames':decoded[0],'positionMs':position,'decodedSizes':sorted(sizes),'distinctPixelSamples':len(set(samples))}
    assert not any('QtWebEngine' in name for name in sys.modules)
    report={'passed':True,'version':VERSION,'frozen':FROZEN,'nativeWidgetsImported':True,'nativeSidebarConstructed':True,'bundledBrowserKernel':False,'extensionBundled':False,'bundledNode':node.stdout.strip(),'systemOcr':{'passed':True,'scope':'generated-English-image','text':recognized},'videoPlayback':playback}
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')


def main():
    app=QApplication(sys.argv); app.setWindowIcon(QIcon(str(ROOT/'public/brand/app.ico')))
    window=Launcher()
    if '--self-check' in sys.argv:self_check(app,window,Path(sys.argv[sys.argv.index('--self-check')+1])); return 0
    window.show()
    if '--menu' not in sys.argv:QTimer.singleShot(0,window.open_app)
    return app.exec()


if __name__=='__main__':raise SystemExit(main())
