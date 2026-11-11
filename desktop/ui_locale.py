"""原生播放器与网页窗口的界面文字；视频标题和课程正文不翻译。"""
EN = {'视频播放 · Vidence':'Video player · Vidence','课程播放 · Vidence':'Course player · Vidence','Vidence · 学习空间':'Vidence · Learning space','播放':'Play','暂停':'Pause','静音':'Mute','取消静音':'Unmute','全屏':'Fullscreen','退出全屏':'Exit fullscreen','学习侧栏':'Learning sidebar','视频进度':'Video position','音量':'Volume','播放或暂停':'Play or pause','选择视频':'Choose a video','系统默认浏览器':'System browser','应用内播放（支持网页全屏）':'In-app player (fullscreen supported)'}
TW = {'视频播放 · Vidence':'影片播放 · Vidence','课程播放 · Vidence':'課程播放 · Vidence','Vidence · 学习空间':'Vidence · 學習空間','播放':'播放','暂停':'暫停','静音':'靜音','取消静音':'取消靜音','全屏':'全螢幕','退出全屏':'退出全螢幕','学习侧栏':'學習側欄','视频进度':'影片進度','音量':'音量','播放或暂停':'播放或暫停','选择视频':'選擇影片','系统默认浏览器':'系統預設瀏覽器','应用内播放（支持网页全屏）':'應用程式內播放（支援網頁全螢幕）'}


def ui_text(text, locale): return (EN if locale == 'en' else TW if locale == 'zh-TW' else {}).get(text, text)
