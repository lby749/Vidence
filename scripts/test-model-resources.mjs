// 验证下载链路时使用用户提供的本机测试资源，不冒充公网下载成功。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export async function installTestResources(page, navigate = true, tierTitle = '高占用') {
  const server = http.createServer((request, response) => {
    const file = path.resolve('public', decodeURIComponent(new URL(request.url, 'http://test').pathname).slice(1));
    const root = path.resolve('public') + path.sep;
    if (!file.startsWith(root) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const port = server.address().port;
  await page.route(/https:\/\/(hf-mirror\.com|paddle-model-ecology\.bj\.bcebos\.com)\//, async route => {
    const url = new URL(route.request().url());
    const file = url.hostname === 'hf-mirror.com'
      ? path.join('public/models', url.pathname.replace(/^\//, '').replace(/\/resolve\/[^/]+\//, '/'))
      : path.join('public/ocr', path.posix.basename(url.pathname));
    if (!fs.existsSync(file)) throw new Error(`缺少本机测试资源 ${file}`);
    await route.fulfill({ status: 302, headers: { Location: `http://127.0.0.1:${port}/${path.relative('public', file).replaceAll('\\', '/')}` } });
  });
  try {
  if (navigate) await page.goto(new URL('library.html?tab=settings', page.url()).href);
  else await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '离线功能', exact: true }).click();
  await page.getByRole('radio', { name: tierTitle, exact: true }).check();
  await page.getByRole('button', { name: '正在检查资源…', exact: true }).waitFor({ state:'hidden' });
  const enable = page.getByRole('button', { name: new RegExp(`^(下载并启用${tierTitle}|启用${tierTitle})$`) });
  if (await enable.count()) {
    await enable.click();
    await Promise.race([page.getByRole('status').filter({ hasText: `${tierTitle}已启用` }).waitFor({ timeout: 90000 }), page.getByRole('alert').waitFor({ timeout: 90000 }).then(async () => { throw new Error(await page.getByRole('alert').innerText()); })]);
  }
  await page.unroute(/https:\/\/(hf-mirror\.com|paddle-model-ecology\.bj\.bcebos\.com)\//);
  console.log('MODEL_RESOURCES', 'Browser OCR/extension files served from retained local test resources; native desktop models use their own downloader; SHA-256 checked');
  } finally { server.close(); }
}
