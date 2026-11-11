"""网页课程身份与展示信息；标题变化不改变视频身份。"""
import re
from urllib.parse import parse_qsl, urlsplit


def web_identity(address):
    parsed = urlsplit(address)
    return (parsed.netloc, parsed.path, tuple((key, value) for key, value in parse_qsl(parsed.query) if key not in ('t', 'spm_id_from', 'vd_source')), parsed.fragment)


def platform_for_url(address):
    host = (urlsplit(address).hostname or '').lower()
    for domain, label in [('bilibili.com','Bilibili'), ('youtube.com','YouTube'), ('youtu.be','YouTube'), ('douyin.com','抖音'), ('coursera.org','Coursera'), ('edx.org','edX'), ('udemy.com','Udemy'), ('khanacademy.org','Khan Academy'), ('icourse163.org','中国大学 MOOC'), ('xuetangx.com','学堂在线'), ('chaoxing.com','学习通'), ('zhihuishu.com','智慧树'), ('xueersi.com','学而思'), ('gaotu.cn','高途'), ('genshuixue.com','高途'), ('zuoyebang.com','作业帮（一课客户端）')]:
        if host == domain or host.endswith('.' + domain): return label
    return '网页课程'


def clean_page_title(title):
    value = re.sub(r'\s+', ' ', str(title or '')).strip()
    return re.sub(r'\s*(?:[-_|]\s*YouTube|[_-]\s*哔哩哔哩.*)$', '', value, flags=re.I).strip()[:240]
