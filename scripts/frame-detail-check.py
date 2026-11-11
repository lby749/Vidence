"""4K细字/细线测试片：验证存档原图不复用1280预览。"""
from pathlib import Path
import base64
import json
import math
import os
import shutil
import subprocess
import sys
import time
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
folder = root / 'artifacts/frame-detail'; folder.mkdir(parents=True, exist_ok=True)
chart = Image.new('RGB', (3840, 2160), 'white'); draw = ImageDraw.Draw(chart)
font = ImageFont.truetype(str(Path(os.environ['WINDIR']) / 'Fonts/arial.ttf'), 20)
draw.text((96, 48), 'f(x) = 17x^2 - 23x + 5/7     Small text at native 4K', font=font, fill='black')
for x in range(96, 384, 4): draw.line((x, 100, x, 200), fill='black', width=1)
draw.rectangle((500, 100, 3500, 1800), outline='black', width=2)
chart.save(folder / 'source.png')
subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', str(folder / 'source.png'), '-t', '3', '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-y', str(folder / 'detail.mp4')], check=True)
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VMA_STATE_DIR'] = str(folder / 'state')
sys.path.insert(0, str(root / 'desktop'))
from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QImage
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget
from app import NativeBridge
(root / 'artifacts/frame-detail-check.json').unlink(missing_ok=True)
app = QApplication([]); window = QMainWindow(); window.setCentralWidget(QWidget()); bridge = NativeBridge(window)
bridge.audio.setMuted(True); bridge.load_video(folder / 'detail.mp4'); bridge.presentation.attach()
def check():
    if not bridge.latest_frame.isValid(): return
    bridge.player.pause()
    preview = json.loads(bridge.frame()); high = json.loads(bridge.keyframe(3840))
    high_bytes = base64.b64decode(high['dataUrl'].split(',')[1]); (folder / 'actual-saved.jpg').write_bytes(high_bytes)
    low = QImage.fromData(base64.b64decode(preview['dataUrl'].split(',')[1])); full = QImage.fromData(high_bytes)
    assert low.width() == 1280 and full.width() == 3840
    up = low.scaled(3840, 2160, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)
    def contrast(image):
        values = [image.pixelColor(x, 150).lightness() for x in range(108, 372)]; mean = sum(values)/len(values)
        return math.sqrt(sum((value-mean)**2 for value in values)/len(values))
    high_contrast, preview_contrast = contrast(full), contrast(up)
    assert high_contrast > preview_contrast * 1.8
    full.copy(80, 30, 640, 200).scaled(1280, 400).save(str(folder / 'detail-full.png'))
    up.copy(80, 30, 640, 200).scaled(1280, 400).save(str(folder / 'detail-preview.png'))
    report = {'scope': 'generated-native-4k-video-detail-not-platform-source', 'sourceWidth': 3840, 'previewWidth': low.width(), 'savedWidth': full.width(), 'savedTime': high['mediaTime'], 'fullLineContrast': high_contrast, 'previewLineContrast': preview_contrast, 'passed': True}
    (root / 'artifacts/frame-detail-check.json').write_text(json.dumps(report, indent=2), encoding='utf-8'); print(json.dumps(report), flush=True)
    app.quit()
timer = QTimer(); timer.timeout.connect(check); timer.start(300); QTimer.singleShot(8000, app.quit)
try: app.exec()
finally: bridge.stopCapture(); window.close()
assert (root / 'artifacts/frame-detail-check.json').is_file()
