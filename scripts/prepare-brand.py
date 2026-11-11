"""将用户提供的品牌原图转换为标准 PNG/ICO 尺寸；不改变设计。"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
source = root / 'assets/brand/logo-source.png'
output = root / 'public/brand'
output.mkdir(parents=True, exist_ok=True)
with Image.open(source) as image:
    image = image.convert('RGBA')
    for size in (16, 32, 48, 128, 256, 512):
        image.resize((size, size), Image.Resampling.LANCZOS).save(output / f'icon-{size}.png')
    image.save(output / 'app.ico', sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
print('品牌图标 PNG/ICO 已准备')
