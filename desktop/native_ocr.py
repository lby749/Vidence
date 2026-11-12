"""使用 Windows 已安装的文字识别能力；不下载或上传图片。"""
import asyncio
import re
from PySide6.QtCore import Qt
from PySide6.QtGui import QImage


def recognize(image, language='auto'):
    if image.isNull(): raise ValueError('没有可识别的画面')
    try:
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.globalization import Language
        from winrt.windows.graphics.imaging import SoftwareBitmap, BitmapPixelFormat, BitmapAlphaMode
        from winrt.windows.storage.streams import DataWriter
    except ImportError:
        raise RuntimeError('文字识别组件尚未准备好；画面记录仍可使用') from None
    available = list(OcrEngine.available_recognizer_languages)
    if not available: raise RuntimeError('系统尚未安装可用的文字识别语言')
    if language == 'auto':
        requested = next((item for item in available if item.language_tag.lower().startswith('zh')), available[0])
    else: requested = Language(language)
    engine = OcrEngine.try_create_from_language(requested)
    if engine is None: raise RuntimeError('系统尚未安装所选文字识别语言')
    target=max(1280,min(1600,image.width()))
    if image.width()!=target:image=image.scaledToWidth(target,Qt.TransformationMode.SmoothTransformation)
    image = image.convertToFormat(QImage.Format.Format_ARGB32)
    writer = DataWriter()
    writer.write_bytes(bytes(image.constBits()))
    bitmap = SoftwareBitmap.create_copy_from_buffer(writer.detach_buffer(), BitmapPixelFormat.BGRA8, image.width(), image.height(), BitmapAlphaMode.IGNORE)
    async def run():
        result = await engine.recognize_async(bitmap)
        return '\n'.join(re.sub(r'(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])','',line.text) for line in result.lines)
    try: return asyncio.run(run())
    finally: bitmap.close(); writer.close()
