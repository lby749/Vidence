"""仅转发用户选定的 AI 接口；凭据不跟随跨站重定向。"""
import urllib.request
import urllib.error
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, *_args): return None


def provider_request(payload):
    address = payload.get('url', '')
    parsed = urlsplit(address)
    if parsed.username or parsed.password or parsed.fragment: raise ValueError('API 地址不能包含账号、密码或片段')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
        raise ValueError('远程 API 请使用 HTTPS；本机服务可以使用 HTTP')
    if not parsed.path.rstrip('/').endswith(('/models', '/chat/completions', '/messages')): raise ValueError('不支持这个 API 接口')
    method = payload.get('method', 'GET')
    if method not in ('GET', 'POST'): raise ValueError('不支持这个请求方式')
    allowed = {'authorization', 'x-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access', 'content-type'}
    headers = {key: value for key, value in payload.get('headers', {}).items() if key.lower() in allowed}
    body = payload.get('body')
    request = urllib.request.Request(address, data=body.encode('utf8') if isinstance(body, str) else None, headers=headers, method=method)
    try: return urllib.request.build_opener(NoRedirect).open(request, timeout=90)
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400: raise ValueError('API 地址发生跳转，请使用服务商提供的最终接口地址') from None
        return error
