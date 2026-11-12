"""原生画面采样。解码与播放不经过此链路；只在主动记录时低频读回。"""
import base64
import time
import uuid
from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtGui import QImage
from presentation import window_title


class Recorder(QObject):
    changed = Signal()
    problem = Signal(str)
    ocr_requested = Signal(str, str, object, float)

    def __init__(self, bridge, store):
        super().__init__(bridge)
        self.bridge, self.store = bridge, store
        self.video_id = None
        self.previous = self.saved = None
        self.last_saved = 0
        self.started = self.pending = 0
        self.timer = QTimer(self); self.timer.setInterval(1200); self.timer.timeout.connect(self.sample)
        self.ocr_busy = False
        self.last_ocr = 0
        self.waiting_warned = False

    def start(self, video_id):
        self.stop(); self.video_id = video_id
        self.started = time.monotonic(); self.previous = self.saved = None
        self.offset=max([row.get('endTime',row.get('time',0)) for kind in ('keyframes','evidence') for row in self.store.rows(kind,video_id)]+[0]) if self.bridge.mode=='window' else 0
        self.last_saved = self.pending = 0
        self.waiting_warned = False
        self.session = uuid.uuid4().hex
        self.store.put('sessions', video_id, {'id': self.session, 'createdAt': int(time.time()*1000)})
        self.timer.start(); self.changed.emit()

    def stop(self):
        self.timer.stop(); self.video_id = None; self.changed.emit()

    @staticmethod
    def signature(image):
        # 48×27网格保留局部变化，底部控件不参与；不遍历高清原图。
        small = image.copy(0, 0, image.width(), max(1, int(image.height()*.94))).scaled(48, 27).convertToFormat(QImage.Format.Format_RGB32)
        raw = bytes(small.constBits())
        values=[]
        for offset in range(0,len(raw),4):
            b,g,r=raw[offset:offset+3]; values.extend(((299*r+587*g+114*b)//1000,r,b))
        return values

    @staticmethod
    def difference(a, b):
        values = [abs(x-y)/255 for x, y in zip(a, b)]
        return sum(values)/len(values), sum(value > .12 for value in values)

    def sample(self, manual=False):
        video_id = self.video_id
        if not video_id: return
        if not self.bridge.current_source or self.bridge.current_source.get('id')!=video_id:
            self.stop(); self.problem.emit('视频来源已改变，已停止旧视频的记录。'); return
        expected=self.bridge.current_source.get('captureTitle')
        if expected:
            current=window_title(self.bridge.target_window)
            if current is not None and current!=expected:
                self.stop(); self.problem.emit('课程窗口标题已变化，已停止记录。请重新选择课程，避免混入其他视频。'); return
        if self.bridge.mode == 'local' and not self.bridge.player.isPlaying() and not manual: return
        if self.bridge.capture_error or self.bridge.media_error:
            self.problem.emit(self.bridge.capture_error or self.bridge.media_error); self.stop(); return
        if not self.bridge.latest_frame.isValid():
            if manual or (not self.waiting_warned and time.monotonic()-self.started>=5):
                self.waiting_warned=True; self.problem.emit('尚未取得课程画面，请保持课程窗口可见，播放片刻后再记录。')
            return
        if self.waiting_warned:
            self.waiting_warned=False; self.problem.emit('已取得课程画面，可以继续记录。')
        if not manual and time.time_ns() - self.bridge.latest_frame_stamp > 8_000_000_000: return
        image = self.bridge.latest_frame.toImage()
        if image.isNull(): return
        signature = self.signature(image)
        if max(signature[::3])-min(signature[::3]) < 6 and not manual: return
        now = time.monotonic()
        tier=self.store.setting('resourceTier','none'); ocr_gap={'low':10,'medium':5,'high':2.5}.get(tier,10)
        if self.store.setting('ocrEnabled',False) and not self.ocr_busy and now-self.last_ocr>=ocr_gap:
            self.ocr_busy=True; self.last_ocr=now
            roi=self.store.setting('ocrRegion',[0,0,1,1])
            text_image=image.copy(int(roi[0]*image.width()),int(roi[1]*image.height()),max(1,int(roi[2]*image.width())),max(1,int(roi[3]*image.height())))
            stamp=self.bridge.latest_frame_time if self.bridge.mode=='local' else self.offset+now-self.started
            self.ocr_requested.emit(video_id,'',text_image,stamp)
        stable = self.previous is not None and self.difference(signature, self.previous)[0] <= .02 and self.difference(signature, self.previous)[1] <= 97
        self.previous = signature
        if not manual:
            if self.saved:
                mean, cells = self.difference(signature, self.saved)
                if mean < .045 and cells < 6: self.pending = 0; return
            if not self.pending: self.pending = now
            if now-self.last_saved < 4 or (not stable and now-self.pending < 8): return
            if len(self.store.rows('keyframes', video_id)) >= self.store.setting('frameBudget', 60): return
        from PySide6.QtCore import QBuffer, QIODevice, Qt
        original = image.scaledToWidth(3840, Qt.TransformationMode.SmoothTransformation) if image.width() > 3840 else image
        buffer = QBuffer(); buffer.open(QIODevice.OpenModeFlag.WriteOnly); original.save(buffer, 'JPEG', 94)
        identifier = uuid.uuid4().hex
        stamp = self.bridge.latest_frame_time if self.bridge.mode == 'local' else self.offset+now-self.started
        self.store.put('keyframes', video_id, {'id': identifier, 'time': stamp, 'timeSource':'media' if self.bridge.mode=='local' else 'recording', 'width': original.width(), 'height': original.height(), 'imageDataUrl': 'data:image/jpeg;base64,'+base64.b64encode(bytes(buffer.data())).decode(), 'createdAt': int(time.time()*1000)})
        self.saved = signature; self.last_saved = now; self.pending = 0
        self.changed.emit()

    def save_text(self, video_id, frame_id, stamp, text):
        self.ocr_busy = False
        if not self.store.video(video_id) or not text.strip(): return
        previous = self.store.rows('evidence', video_id)
        if previous and previous[-1].get('text') == text.strip() and 0<=stamp-previous[-1].get('endTime',0)<25:
            previous[-1]['endTime']=stamp; self.store.put('evidence',video_id,previous[-1]); return
        self.store.put('evidence', video_id, {'id': uuid.uuid4().hex, 'text': text.strip()[:4000], 'startTime': stamp, 'endTime': stamp, 'frameId': frame_id, 'source': 'native-ocr'})
        self.changed.emit()
