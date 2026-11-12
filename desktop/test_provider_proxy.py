import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from provider_proxy import api_base, provider_request


class ProxyChecks(unittest.TestCase):
    def test_api_endpoint_normalization(self):
        self.assertEqual(api_base('https://example.com/v1/chat/completions?ignored=1'), 'https://example.com/v1')
        self.assertEqual(api_base('https://example.com/v1/models/'), 'https://example.com/v1')
        self.assertEqual(api_base('https://example.com', True), 'https://example.com/v1')
        self.assertEqual(api_base('https://example.com/v1/messages', True), 'https://example.com/v1')

    def test_no_remote_plaintext_or_url_credentials(self):
        for address in ['http://example.com/v1/models', 'https://user:secret@example.com/v1/models', 'https://example.com/files']:
            with self.assertRaises(ValueError): provider_request({'url': address})

    def test_redirect_does_not_forward_credentials(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(302); self.send_header('Location', '/stolen/models'); self.end_headers()
            def log_message(self, *_args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with self.assertRaisesRegex(ValueError, '跳转'):
                provider_request({'url': f'http://127.0.0.1:{server.server_port}/v1/models', 'headers': {'Authorization': 'Bearer fixture'}})
            self.assertEqual(seen, ['/v1/models'])
        finally: server.shutdown(); server.server_close()


if __name__ == '__main__': unittest.main()
