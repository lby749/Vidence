"""只读取公开版本元数据，不发送学习数据、账号或密钥。"""
import json
import re
import time
import urllib.request
from urllib.parse import urlsplit
from provider_proxy import NoRedirect
from app_version import TAG_PREFIX

REPOSITORY='lby749/Vidence'
RELEASES='https://github.com/'+REPOSITORY+'/releases'


def version_key(value):
    if not isinstance(value,str) or len(value)>120:return None
    match=re.fullmatch(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?',value)
    if not match:return None
    pre=match[4].split('.') if match[4] else []
    if any(not item or (item.isdigit() and len(item)>1 and item.startswith('0')) for item in pre):return None
    return (*map(int,match.group(1,2,3)),not bool(pre),tuple((0,int(item)) if item.isdigit() else (1,item) for item in pre))


def newest_release(rows,current):
    current_key=version_key(current)
    if not isinstance(rows,list) or current_key is None:raise ValueError('版本目录无效')
    selected=None; highest=current_key
    for row in rows:
        if not isinstance(row,dict) or row.get('draft') or not row.get('published_at'):continue
        tag=row.get('tag_name','')
        if not isinstance(tag,str) or not tag.startswith(TAG_PREFIX):continue
        assets=row.get('assets')
        if not isinstance(assets,list) or not any(isinstance(asset,dict) and asset.get('name')=='Vidence-Desktop-Windows-x64.zip' for asset in assets):continue
        key=version_key(tag.removeprefix(TAG_PREFIX)); url=urlsplit(row.get('html_url',''))
        if key is None or key<=highest or (current_key[3] and (row.get('prerelease') or not key[3])):continue
        if url.scheme!='https' or url.netloc!='github.com' or not url.path.startswith('/'+REPOSITORY+'/releases/tag/') or url.query or url.fragment:continue
        selected={'version':tag.removeprefix(TAG_PREFIX),'url':url.geturl(),'notes':str(row.get('body',''))[:1600]}; highest=key
    return selected


def check_updates(store,current,force=False):
    saved=store.setting('appUpdates',{'auto':True,'checkedAt':0}); now=int(time.time())
    if saved.get('channel')!='desktop':
        saved={'auto':saved.get('auto',True),'checkedAt':0,'channel':'desktop'}
        store.set_setting('appUpdates',saved)
    if not force and (not saved.get('auto',True) or 0<=now-saved.get('checkedAt',0)<86400):return saved
    try:
        request=urllib.request.Request('https://api.github.com/repos/'+REPOSITORY+'/releases?per_page=20',headers={'Accept':'application/vnd.github+json','User-Agent':'Vidence-version-check'})
        with urllib.request.build_opener(NoRedirect).open(request,timeout=10) as response:rows=json.load(response)
        saved.update(checkedAt=now,update=newest_release(rows,current),error=None)
    except Exception:saved.update(checkedAt=now,error='暂时无法检查版本，请稍后重试。')
    store.set_setting('appUpdates',saved); return saved
