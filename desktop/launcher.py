"""随发布包提供的启动及浏览器安装向导，不调用用户的 Python、Node 或 npm。"""
from pathlib import Path
from contextlib import contextmanager
import hashlib
import json
import os
import shutil
import subprocess
import sys

from PySide6.QtCore import QLocale, QProcess, QTimer, QUrl, Qt
from PySide6.QtGui import QDesktopServices, QIcon, QPixmap
from PySide6.QtWidgets import QApplication, QComboBox, QFrame, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget
if '--self-check' in sys.argv:
    from PySide6 import QtMultimedia, QtMultimediaWidgets, QtWebChannel, QtWebEngineWidgets, QtWebView

FROZEN = getattr(sys, 'frozen', False)
ROOT = Path(sys._MEIPASS) if FROZEN else Path(__file__).resolve().parents[1]
APP_DIR = Path(sys.executable).parent if FROZEN else ROOT / 'dist/desktop-player/视频记忆助手'
BOOTSTRAP_SHA256 = 'cf2f2445fef0c5c14e372045f84998771eeb8bb01d59be4afd00692fa160082e'
WEBVIEW_KEY = r'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

TEXT = {
    'zh-CN': [
        '视频记忆助手', '准备好，开始学习。', '打开视频，在右侧留下理解、问题与记忆。',
        '无需配置环境。所需程序随包提供，模型按你的选择下载。', '打开学习空间', '安装浏览器插件',
        '在浏览器里，也能随看随记。', '选择你平时使用的浏览器', '准备插件并打开安装页',
        '1  打开「开发人员模式」\n2  点「加载解压缩的扩展」，粘贴下方路径\n3  确认后，刷新视频页面即可使用',
        '复制路径', '打开插件文件夹', '路径已复制。请在浏览器完成上面的确认步骤。',
        '正在准备插件文件…', '插件文件已就绪，路径已复制。尚需在浏览器确认安装。',
        '没有检测到 Edge 或 Chrome。安装浏览器后重新打开这里。', '准备首次网页播放组件，需要联网…',
        '网页播放组件准备失败，请联网重试。也可以先打开本地视频。', '先用本地视频',
        '文件不完整，请重新解压整个发布包。', '正在打开学习空间…', '网页播放组件正在准备，请稍候再关闭。',
        '首次缺少网页播放组件时自动准备，不需要你另找安装包。', '该浏览器未能打开，请重试。',
    ],
    'zh-TW': [
        '影片記憶助手', '準備好，開始學習。', '開啟影片，在右側留下理解、問題與記憶。',
        '無需設定環境。所需程式隨包提供，模型依你的選擇下載。', '開啟學習空間', '安裝瀏覽器擴充功能',
        '在瀏覽器裡，也能隨看隨記。', '選擇你平時使用的瀏覽器', '準備檔案並開啟安裝頁',
        '1  開啟「開發人員模式」\n2  點「載入未封裝項目」，貼上下方路徑\n3  確認後，重新整理影片頁面即可使用',
        '複製路徑', '開啟擴充功能資料夾', '路徑已複製。請在瀏覽器完成上面的確認步驟。',
        '正在準備擴充功能檔案…', '檔案已就緒，路徑已複製。仍需在瀏覽器確認安裝。',
        '未偵測到 Edge 或 Chrome。安裝瀏覽器後重新開啟這裡。', '正在準備首次網頁播放元件，需要連線…',
        '網頁播放元件準備失敗，請連線重試。也可以先開啟本機影片。', '先用本機影片',
        '檔案不完整，請重新解壓縮整個發佈包。', '正在開啟學習空間…', '網頁播放元件正在準備，請稍候再關閉。',
        '首次缺少網頁播放元件時自動準備，無需另外尋找安裝程式。', '無法開啟這個瀏覽器，請重試。',
    ],
    'en': [
        'Video Memory', 'Ready when you are.', 'Keep your understanding, questions and memories beside the video.',
        'No environment setup. Everything needed is included; download models when you choose.', 'Open learning space', 'Add to your browser',
        'Watch and remember, in your browser.', 'Choose your everyday browser', 'Prepare files and open installation',
        '1  Turn on “Developer mode”\n2  Choose “Load unpacked” and paste the path below\n3  Confirm, then refresh your video page',
        'Copy path', 'Open extension folder', 'Path copied. Complete the confirmation steps in your browser.',
        'Preparing extension files…', 'Files ready and path copied. Confirm installation in your browser.',
        'Edge or Chrome was not found. Install a browser and reopen this window.', 'Preparing web playback for the first time. Internet is required…',
        'Web playback setup failed. Reconnect and retry, or open a local video first.', 'Use local videos first',
        'Files are missing. Extract the entire release package again.', 'Opening your learning space…', 'Web playback is being prepared. Please wait before closing.',
        'Missing web playback components are prepared automatically on first use.', 'Could not open this browser. Please retry.',
    ],
}


def extension_directory():
    return Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'VideoMemoryAssistant/browser-extension'


def prepare_extension(source, destination):
    source, destination = Path(source), Path(destination)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('manifest_version') != 3:
        raise ValueError('Invalid extension manifest')
    entries = [manifest['background']['service_worker'], manifest['side_panel']['default_path'], manifest['options_ui']['page']]
    entries += [file for script in manifest.get('content_scripts', []) for file in script.get('js', [])]
    for entry in entries:
        file = (source / entry).resolve()
        if source.resolve() not in file.parents or not file.is_file():
            raise ValueError('Missing or invalid extension entry')
    for file in source.rglob('*'):
        if file.is_symlink() or file.suffix.lower() in ('.onnx', '.gguf', '.safetensors', '.tar'):
            raise ValueError('Unexpected extension resource')
    shutil.copytree(source, destination, dirs_exist_ok=True)
    return destination


def installed_browsers():
    if os.name != 'nt': return []
    import winreg
    found = []
    for name, executable, relative, page in [
        ('Microsoft Edge', 'msedge.exe', 'Microsoft/Edge/Application/msedge.exe', 'edge://extensions/'),
        ('Google Chrome', 'chrome.exe', 'Google/Chrome/Application/chrome.exe', 'chrome://extensions/'),
    ]:
        candidates = []
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                try:
                    with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\App Paths' + chr(92) + executable, 0, winreg.KEY_READ | view) as key:
                        candidates.append(Path(winreg.QueryValue(key, None).strip('"')))
                except OSError: pass
        candidates += [Path(os.environ[base]) / relative for base in ('LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)') if os.environ.get(base)]
        match = next((file for file in candidates if file.is_file()), None)
        if match: found.append((name, str(match), page))
    return found


def webview_available():
    if os.name != 'nt': return True
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, WEBVIEW_KEY, 0, winreg.KEY_READ | view) as key:
                    version = winreg.QueryValueEx(key, 'pv')[0]
                    if version and version != '0.0.0.0': return True
            except OSError: pass
    return False


@contextmanager
def system_library_paths():
    # 浏览器/微软安装程序使用系统DLL；随包助手仍使用自己的DLL。
    original_path = os.environ.get('PATH', '')
    if FROZEN and os.name == 'nt':
        import ctypes
        ctypes.windll.kernel32.SetDllDirectoryW(None)
        os.environ['PATH'] = os.pathsep.join(entry for entry in original_path.split(os.pathsep) if not Path(entry).is_relative_to(ROOT))
    try: yield
    finally:
        if FROZEN and os.name == 'nt':
            os.environ['PATH'] = original_path
            ctypes.windll.kernel32.SetDllDirectoryW(str(ROOT))


def focus_app():
    if os.name != 'nt': return False
    import ctypes
    from ctypes import wintypes
    api = ctypes.windll.user32
    api.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]; api.FindWindowW.restype = wintypes.HWND
    api.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    api.SetForegroundWindow.argtypes = [wintypes.HWND]
    api.IsIconic.argtypes = [wintypes.HWND]
    for title in ('视频记忆助手 · 学习空间', '影片記憶助手 · 學習空間', 'Video Memory · Learning space'):
        window = api.FindWindowW(None, title)
        if window:
            if api.IsIconic(window): api.ShowWindow(window, 9)
            api.SetForegroundWindow(window)
            return True
    return False


class Launcher(QWidget):
    def __init__(self, install=False):
        super().__init__()
        self.setMinimumWidth(600); self.resize(680, 470)
        self.runtime_process = None
        self.language = QComboBox()
        for label, value in [('简体中文', 'zh-CN'), ('繁體中文', 'zh-TW'), ('English', 'en')]: self.language.addItem(label, value)
        system = QLocale.system().name()
        self.language.setCurrentIndex(1 if system in ('zh_TW', 'zh_HK', 'zh_MO') else 0 if system.startswith('zh') else 2)
        self.language.currentIndexChanged.connect(self.retranslate)
        layout = QVBoxLayout(self); layout.setContentsMargins(36, 26, 36, 30); layout.setSpacing(17)
        header = QHBoxLayout(); logo = QLabel(); logo.setPixmap(QPixmap(str(ROOT / '.output/chrome-mv3/brand/icon-128.png')).scaled(32, 32, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)); header.addWidget(logo); brand = QLabel('VIDEO MEMORY · BETA'); brand.setObjectName('brand'); header.addWidget(brand); header.addStretch(); header.addWidget(self.language); layout.addLayout(header)
        self.title = QLabel(); self.title.setObjectName('title'); layout.addWidget(self.title)
        self.intro = QLabel(); self.intro.setWordWrap(True); layout.addWidget(self.intro)
        self.environment = QLabel(); self.environment.setWordWrap(True); self.environment.setObjectName('muted'); layout.addWidget(self.environment)
        actions = QHBoxLayout()
        self.open_button = QPushButton(); self.open_button.setObjectName('primary'); self.open_button.clicked.connect(self.open_app)
        self.install_button = QPushButton(); self.install_button.clicked.connect(lambda: self.install_panel.setVisible(not self.install_panel.isVisible()))
        actions.addWidget(self.open_button); actions.addWidget(self.install_button); layout.addLayout(actions)
        self.install_panel = QFrame(); self.install_panel.setObjectName('card'); card = QVBoxLayout(self.install_panel); card.setContentsMargins(20, 20, 20, 20); card.setSpacing(12)
        self.install_title = QLabel(); self.install_title.setObjectName('subtitle'); card.addWidget(self.install_title)
        self.browser_label = QLabel(); card.addWidget(self.browser_label)
        self.browsers = QComboBox()
        for name, executable, page in installed_browsers(): self.browsers.addItem(name, (executable, page))
        card.addWidget(self.browsers)
        self.prepare_button = QPushButton(); self.prepare_button.setObjectName('primary'); self.prepare_button.clicked.connect(self.prepare); card.addWidget(self.prepare_button)
        self.steps = QLabel(); self.steps.setWordWrap(True); card.addWidget(self.steps)
        self.path = QLineEdit(str(extension_directory())); self.path.setReadOnly(True); card.addWidget(self.path)
        utilities = QHBoxLayout(); self.copy_button = QPushButton(); self.copy_button.clicked.connect(self.copy_path); self.folder_button = QPushButton(); self.folder_button.clicked.connect(self.open_folder)
        utilities.addWidget(self.copy_button); utilities.addWidget(self.folder_button); card.addLayout(utilities)
        layout.addWidget(self.install_panel); self.install_panel.setVisible(install)
        self.note = QLabel(); self.note.setWordWrap(True); self.note.setObjectName('muted'); layout.addWidget(self.note)
        self.status = QLabel(); self.status.setWordWrap(True); layout.addWidget(self.status)
        self.local_button = QPushButton(); self.local_button.clicked.connect(self.launch_app); self.local_button.hide(); layout.addWidget(self.local_button)
        layout.addStretch()
        self.setStyleSheet('''QWidget { background:#f5f5f7; color:#1d1d1f; font:14px "Segoe UI"; }
            QLabel#title { font-size:32px; font-weight:600; } QLabel#subtitle { font-size:18px; font-weight:600; }
            QLabel#brand { color:#86868b; font-size:11px; font-weight:600; letter-spacing:2px; } QLabel#muted { color:#6e6e73; }
            QPushButton,QComboBox,QLineEdit { background:white; border:1px solid #dedee3; border-radius:10px; padding:11px 15px; }
            QPushButton:hover { background:#e9edf5; } QPushButton#primary { background:#0071e3; color:white; border:0; }
            QPushButton#primary:hover { background:#0077ed; } QPushButton:disabled { color:#98989d; background:#e8e8ed; }
            QFrame#card { background:white; border:1px solid #e5e5ea; border-radius:18px; } QFrame#card QLabel { background:transparent; }
            QComboBox::drop-down { border:0; width:22px; } QComboBox QAbstractItemView { background:white; selection-background-color:#0071e3; }
        ''')
        self.retranslate()

    def text(self, index): return TEXT[self.language.currentData()][index]

    def retranslate(self):
        self.setWindowTitle(self.text(0))
        for widget, index in [(self.title, 1), (self.intro, 2), (self.environment, 3), (self.open_button, 4), (self.install_button, 5), (self.install_title, 6), (self.browser_label, 7), (self.prepare_button, 8), (self.steps, 9), (self.copy_button, 10), (self.folder_button, 11), (self.local_button, 18), (self.note, 22)]: widget.setText(self.text(index))
        self.prepare_button.setEnabled(self.browsers.count() > 0)
        if not self.browsers.count(): self.status.setText(self.text(15))

    def copy_path(self):
        QApplication.clipboard().setText(self.path.text()); self.status.setText(self.text(12))

    def open_folder(self):
        directory = extension_directory()
        if directory.is_dir(): QDesktopServices.openUrl(QUrl.fromLocalFile(str(directory)))

    def prepare(self):
        self.status.setText(self.text(13)); self.prepare_button.setEnabled(False); QApplication.processEvents()
        try:
            prepare_extension(ROOT / '.output/chrome-mv3', extension_directory())
            QApplication.clipboard().setText(str(extension_directory()))
            executable, page = self.browsers.currentData()
            with system_library_paths():
                subprocess.Popen([executable, page], creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            self.status.setText(self.text(14))
        except (OSError, ValueError, KeyError): self.status.setText(self.text(19))
        finally: self.prepare_button.setEnabled(True)

    def open_app(self):
        if focus_app(): self.close(); return
        if webview_available(): return self.launch_app()
        setup = ROOT / 'desktop/runtime/webview2/MicrosoftEdgeWebview2Setup.exe'
        if not setup.is_file() or hashlib.sha256(setup.read_bytes()).hexdigest() != BOOTSTRAP_SHA256:
            self.status.setText(self.text(19)); self.local_button.show(); return
        self.status.setText(self.text(16)); self.open_button.setEnabled(False)
        self.runtime_process = QProcess(self)
        self.runtime_process.finished.connect(self.runtime_finished)
        self.runtime_process.errorOccurred.connect(lambda _error: self.runtime_finished(-1))
        with system_library_paths():
            self.runtime_process.start(str(setup), ['/silent', '/install'])
            self.runtime_process.waitForStarted(5000)

    def runtime_finished(self, _code, *_args):
        self.open_button.setEnabled(True)
        if webview_available(): self.launch_app()
        else: self.status.setText(self.text(17)); self.local_button.show()

    def launch_app(self):
        executable = APP_DIR / '视频记忆助手.exe'
        if not executable.is_file(): self.status.setText(self.text(19)); return
        started, _pid = QProcess.startDetached(str(executable), [], str(APP_DIR))
        if started: self.close()
        else: self.status.setText(self.text(19))

    def closeEvent(self, event):
        if self.runtime_process and self.runtime_process.state() != QProcess.ProcessState.NotRunning:
            self.status.setText(self.text(21)); event.ignore()
        else: event.accept()


def main():
    app = QApplication(sys.argv)
    app.setWindowIcon(QIcon(str(ROOT / '.output/chrome-mv3/brand/app.ico')))
    if '--self-check' in sys.argv:
        # Windows 的 offscreen 插件不枚举系统字体；仅验收时显式加载。
        from PySide6.QtGui import QFontDatabase
        for name in ('segoeui.ttf', 'msyh.ttc'):
            font = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Fonts' / name
            if font.is_file(): QFontDatabase.addApplicationFont(str(font))
    window = Launcher('--install-browser' in sys.argv)
    if '--self-check' in sys.argv:
        import tempfile
        report_path = Path(sys.argv[sys.argv.index('--self-check') + 1])
        with tempfile.TemporaryDirectory(prefix='vma-extension-check-') as temporary:
            copied = prepare_extension(ROOT / '.output/chrome-mv3', Path(temporary) / 'extension')
            assert (copied / 'manifest.json').is_file()
            copied_files = sum(file.is_file() for file in copied.rglob('*'))
        runtime = ROOT / 'runtime/node.exe'
        node = subprocess.run([str(runtime), '--version'], capture_output=True, text=True, check=True)
        assert (APP_DIR / '视频记忆助手.exe').is_file()
        assert hashlib.sha256((ROOT / 'desktop/runtime/webview2/MicrosoftEdgeWebview2Setup.exe').read_bytes()).hexdigest() == BOOTSTRAP_SHA256
        window.install_panel.show(); window.show(); app.processEvents()
        window.grab().save(str(report_path.with_suffix('.png')))
        report_path.write_text(json.dumps({'passed': True, 'frozen': FROZEN, 'nativePlaybackAndWebBindingsImported': True, 'bundledNode': node.stdout.strip(), 'extensionFiles': copied_files, 'browsersDetected': window.browsers.count(), 'webviewInstalled': webview_available(), 'languages': list(TEXT), 'noExtensionInstalledDuringCheck': True}, ensure_ascii=False, indent=2), encoding='utf-8')
        return 0
    window.show()
    if '--open' in sys.argv: QTimer.singleShot(0, window.open_app)
    return app.exec()


if __name__ == '__main__': raise SystemExit(main())
