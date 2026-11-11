"""真实H264解码的无界面帧节奏与采样开销对照，不冒充屏幕呈现率。"""
import base64
import json
import os
from pathlib import Path
import sys
import time
from fractions import Fraction

root = Path(__file__).resolve().parents[1]
before = '--before' in sys.argv
source = Path(sys.argv[sys.argv.index('--source') + 1]) if '--source' in sys.argv else root / 'artifacts/keyframe-audit/BV1G7jJ6nEbV/video.mp4'
rate = sys.argv[sys.argv.index('--fps') + 1] if '--fps' in sys.argv else '30'
output_name = sys.argv[sys.argv.index('--output') + 1] if '--output' in sys.argv else None
if '--onscreen' not in sys.argv: os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VMA_STATE_DIR'] = str(root / 'artifacts' / ('cadence-before-state' if before else 'cadence-after-state'))
sys.path.insert(0, str(root / 'artifacts/player-before' if before else root / 'desktop'))
from PySide6.QtCore import QTimer
from PySide6.QtGui import QImage
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget
from app import NativeBridge

app = QApplication([])
window = QMainWindow(); window.resize(1280, 800); window.setCentralWidget(QWidget())
window.setWindowTitle('视频帧率验收 · 静音 · 自动关闭')
bridge = NativeBridge(window)
events, shown, handler_ms, sample_ms, pictures = [], [], [], [], []
handles, sizes = set(), set()
measuring = False
accept = bridge.accept_frame

def measure(frame):
    started = time.perf_counter(); accept(frame)
    if measuring and frame.isValid():
        events.append(started)
        handles.add(str(frame.handleType())); sizes.add((frame.width(), frame.height()))
        handler_ms.append((time.perf_counter() - started) * 1000)

bridge.accept_frame = measure
if before:
    show = bridge.presentation.show_frame
    def present(image):
        if measuring: shown.append(time.perf_counter())
        show(image)
    bridge.presentation.show_frame = present

def sample():
    if not measuring: return
    started = time.perf_counter(); result = json.loads(bridge.frame()); sample_ms.append((time.perf_counter() - started) * 1000)
    image = QImage.fromData(base64.b64decode(result['dataUrl'].split(',')[1]))
    assert image.width() == 1280
    pictures.append({'width': image.width(), 'time': result['time']})

report = {'scope': 'real-h264-qt-onscreen-cadence-not-screen-present-rate' if '--onscreen' in sys.argv else 'real-h264-qt-offscreen-cadence-not-screen-present-rate', 'version': 'before' if before else 'after', 'onscreenWindow': '--onscreen' in sys.argv, 'sourceRate': rate, 'sourceFile': source.name}
try:
    bridge.audio.setMuted(True)
    bridge.load_video(source)
    bridge.presentation.attach()
    if not before:
        bridge.presentation.player.surface.videoSink().videoFrameChanged.connect(lambda frame: shown.append(time.perf_counter()) if measuring and frame.isValid() else None)
    timer = QTimer(); timer.setInterval(2500); timer.timeout.connect(sample); timer.start()
    def start():
        global measuring, cpu_start, wall_start
        measuring = True; cpu_start = time.process_time(); wall_start = time.perf_counter()
    QTimer.singleShot(1500, start)
    QTimer.singleShot(9500, app.quit)
    app.exec()
    elapsed = time.perf_counter() - wall_start
    report.update(seconds=elapsed, inputFrames=len(events), deliveredFrames=len(shown), inputFps=len(events)/elapsed, deliveredFps=len(shown)/elapsed, frameHandlerAverageMs=sum(handler_ms)/len(handler_ms), frameHandlerTotalMs=sum(handler_ms), previewRequests=len(pictures), previewAverageMs=sum(sample_ms)/len(sample_ms), pictures=pictures, cpuSeconds=time.process_time()-cpu_start, frameHandleTypes=sorted(handles), decodedSizes=sorted(sizes))
    assert len(pictures) >= 2
    if not before:
        assert report['deliveredFps'] >= float(Fraction(rate)) * .92, report
        assert report['frameHandlerAverageMs'] < 1, report
    report['passed'] = True
finally:
    bridge.stopCapture(); bridge.presentation.timer.stop(); window.close()
    (root / 'artifacts' / (output_name or f'playback-cadence-{report["version"]}{"-onscreen" if report["onscreenWindow"] else ""}.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
