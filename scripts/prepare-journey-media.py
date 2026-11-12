"""Generate two explicit teaching fixtures, not real platform courses."""
import os,subprocess
from pathlib import Path
os.environ['QT_QPA_PLATFORM']='offscreen'
from PIL import Image,ImageDraw,ImageFont
font_folder=Path(os.environ['WINDIR'])/'Fonts'
folder=Path('artifacts/cloud-journey');folder.mkdir(parents=True,exist_ok=True)
for name,title,fact,color in [('ocean','OCEAN LAB','Sample salinity: 37 PSU','red'),('forest','FOREST LAB','Sample population: 82 trees','blue')]:
    image=Image.new('RGB',(960,540),'white');painter=ImageDraw.Draw(image)
    painter.text((40,45),title,font=ImageFont.truetype(str(font_folder/'arial.ttf'),42),fill='black')
    painter.text((40,125),fact,font=ImageFont.truetype(str(font_folder/'arial.ttf'),32),fill='black')
    if name=='ocean':painter.rectangle((600,240,860,420),fill=color)
    else:painter.ellipse((630,220,830,420),fill=color)
    picture=folder/(name+'.png');image.save(picture)
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-loop','1','-i',str(picture),'-r','30000/1001','-t','12','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',str(folder/(name+'.mp4'))],check=True)
