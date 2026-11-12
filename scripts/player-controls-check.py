"""点击自己的原生播放器控件；验证真实解码、进度、音量、全屏和收展。"""
import json
import base64
import os
from pathlib import Path
import sys
import time

root = Path(__file__).resolve().parents[1]
offscreen = '--offscreen' in sys.argv
if offscreen: os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VMA_STATE_DIR'] = str(root / 'artifacts/player-controls-state')
sys.path.insert(0, str(root / 'desktop'))
from PySide6.QtCore import QPoint, Qt
from PySide6.QtTest import QTest
from PySide6.QtGui import QImage
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget
from app import NativeBridge

app = QApplication([])
main = QMainWindow(); main.resize(380, 700); main.setWindowTitle('播放器控件验收 · 自动关闭')
main.setCentralWidget(QWidget())
bridge = NativeBridge(main)
report = {'runtime': 'source-offscreen' if offscreen else 'source', 'fixture': 'owned-local-h264-mp4'}

def wait_for(check, timeout=8000):
    until = time.monotonic() + timeout / 1000
    while time.monotonic() < until:
        QTest.qWait(50)
        if check(): return
    raise AssertionError('等待播放器状态超时')

try:
    bridge.load_video(root / 'artifacts/sidebar-test.mp4'); bridge.audio.setVolume(0)
    bridge.presentation.attach(); player = bridge.presentation.player
    wait_for(lambda: bridge.latest_frame.isValid() and bridge.player.position() > 100)
    sample = json.loads(bridge.frame())
    image = QImage.fromData(base64.b64decode(sample['dataUrl'].split(',')[1]))
    assert image.width() == 1280
    pixel = image.pixelColor(10, 10)
    assert pixel.blue() > 30
    report['decodedPixels'] = [pixel.red(), pixel.green(), pixel.blue()]
    control_image=player.controls.grab().toImage(); control_image.save(str(root/'artifacts/native-control-backplate.png'))
    background = control_image.pixelColor(6, control_image.height() // 2)
    assert background.alpha() > 180 and max(background.red(), background.green(), background.blue()) < 80, f'控制条必须有可读的深色背景：{background.getRgb()}'
    report['readableControlBackplate'] = True
    QTest.mouseClick(player.play, Qt.MouseButton.LeftButton)
    wait_for(lambda: not bridge.player.isPlaying()); report['pauseClick'] = True
    player.seek.setFocus(); QTest.keyClick(player.seek, Qt.Key.Key_End); QTest.keyClick(player.seek, Qt.Key.Key_Left)
    QTest.mouseRelease(player.seek, Qt.MouseButton.LeftButton)
    # 键盘调节也须真正定位，不能只移动滑块外观。
    wait_for(lambda: 13000 < bridge.player.position() < 17000); report['seek'] = True
    player.volume.setFocus(); QTest.keyClick(player.volume, Qt.Key.Key_Home); QTest.keyClick(player.volume, Qt.Key.Key_Right)
    assert abs(bridge.audio.volume() - .01) < .001
    QTest.mouseClick(player.mute, Qt.MouseButton.LeftButton); assert bridge.audio.isMuted()
    QTest.mouseClick(player.mute, Qt.MouseButton.LeftButton); assert not bridge.audio.isMuted(); report['volumeAndMute'] = True
    QTest.mouseClick(player.fullscreen_button, Qt.MouseButton.LeftButton)
    wait_for(main.isFullScreen); assert bridge.presentation.collapsed
    screen = main.screen().geometry(); assert main.geometry().size() == screen.size()
    assert player.surface.height() == player.centralWidget().height(), '全屏控件不能挤占视频画面'
    assert player.surface.width() == main.centralWidget().width(), '全屏默认不保留白色侧栏条'
    main.grab().save(str(root / ('artifacts/player-fullscreen-offscreen.png' if offscreen else 'artifacts/player-fullscreen.png')))
    report['bottomFullscreenClick'] = True
    QTest.keyClick(main, Qt.Key.Key_Escape); wait_for(lambda: not main.isFullScreen())
    assert not bridge.presentation.collapsed; report['escapeRestoresSidebar'] = True
    QTest.mouseClick(player.play, Qt.MouseButton.LeftButton); wait_for(bridge.player.isPlaying)
    QTest.mouseClick(player.fullscreen_button, Qt.MouseButton.LeftButton); wait_for(main.isFullScreen)
    QTest.mouseMove(player.surface, QPoint(100, 100)); QTest.qWait(2800)
    assert not player.controls.isVisible(); report['autoHide'] = True
    QTest.mouseMove(player.surface, QPoint(101, 102)); wait_for(player.controls.isVisible)
    QTest.mouseClick(player.fullscreen_button, Qt.MouseButton.LeftButton); wait_for(lambda: not main.isFullScreen())
    report['bottomExitClick'] = True
    report['passed'] = True
finally:
    bridge.stopCapture(); bridge.presentation.timer.stop()
    if bridge.presentation.player: bridge.presentation.player.close()
    main.close()
    (root / ('artifacts/player-controls-offscreen.json' if offscreen else 'artifacts/player-controls-check.json')).write_text(json.dumps(report, indent=2), encoding='utf8')
print(json.dumps(report))
