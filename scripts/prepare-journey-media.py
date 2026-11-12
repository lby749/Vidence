"""Generate two explicit teaching fixtures, not real platform courses."""
import os,subprocess
from pathlib import Path
os.environ['QT_QPA_PLATFORM']='offscreen'
from PySide6.QtWidgets import QApplication
from PySide6.QtGui import QImage,QPainter,QFont,QColor
app=QApplication([])
folder=Path('artifacts/cloud-journey');folder.mkdir(parents=True,exist_ok=True)
for name,title,fact,color in [('ocean','OCEAN LAB','Sample salinity: 37 PSU','red'),('forest','FOREST LAB','Sample population: 82 trees','blue')]:
    image=QImage(960,540,QImage.Format.Format_RGB32);image.fill(QColor('white'))
    painter=QPainter(image);painter.setPen(QColor('black'));painter.setFont(QFont('Arial',32));painter.drawText(40,90,title)
    painter.setFont(QFont('Arial',24));painter.drawText(40,160,fact);painter.setBrush(QColor(color));painter.setPen(QColor(color))
    if name=='ocean':painter.drawRect(600,240,260,180)
    else:painter.drawEllipse(630,220,200,200)
    painter.end();picture=folder/(name+'.png');image.save(str(picture))
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-loop','1','-i',str(picture),'-r','30000/1001','-t','12','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',str(folder/(name+'.mp4'))],check=True)
