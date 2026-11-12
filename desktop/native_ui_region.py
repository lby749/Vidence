"""在当前画面上拖选文字识别区域，不改变原视频或截图。"""
from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QPainter, QPen, QPixmap
from PySide6.QtWidgets import QDialog, QDialogButtonBox, QLabel, QVBoxLayout


class RegionDialog(QDialog):
    def __init__(self, image, parent=None):
        super().__init__(parent); self.setWindowTitle('拖选文字识别区域'); self.region=[0,0,1,1]
        self.preview=QPixmap.fromImage(image).scaled(900,550,Qt.AspectRatioMode.KeepAspectRatio,Qt.TransformationMode.SmoothTransformation)
        self.origin=None; self.selection=QRect(); layout=QVBoxLayout(self); self.label=QLabel(); self.label.setFixedSize(self.preview.size()); self.label.setPixmap(self.preview); layout.addWidget(self.label)
        self.label.mousePressEvent=self.begin; self.label.mouseMoveEvent=self.move
        buttons=QDialogButtonBox(QDialogButtonBox.StandardButton.Ok|QDialogButtonBox.StandardButton.Cancel); buttons.accepted.connect(self.accept); buttons.rejected.connect(self.reject); layout.addWidget(buttons)
    def begin(self,event):self.origin=event.position().toPoint()
    def move(self,event):
        if self.origin is None:return
        self.selection=QRect(self.origin,event.position().toPoint()).normalized().intersected(self.label.rect())
        if self.selection.width()<3 or self.selection.height()<3:return
        self.region=[self.selection.x()/self.preview.width(),self.selection.y()/self.preview.height(),self.selection.width()/self.preview.width(),self.selection.height()/self.preview.height()]
        shown=self.preview.copy(); painter=QPainter(shown); painter.setPen(QPen(Qt.GlobalColor.blue,2)); painter.drawRect(self.selection); painter.end(); self.label.setPixmap(shown)
