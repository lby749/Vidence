import { defineConfig } from 'wxt';

// WXT 配置：MV3、React、侧边栏、offscreen、本地存储。
// 说明：不在此处申请 <all_urls> 的 host 权限之外的可选权限，
// 截图所需的 tabCapture 由用户点击时按需申请。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      // 本机测试素材保留在 public；发布产物不携带任何模型文件。
      for (let i = files.length - 1; i >= 0; i--) {
        if (/^(models|ocr)\//.test(files[i].relativeDest.replaceAll('\\', '/'))) files.splice(i, 1);
      }
    },
  },
  manifest: {
    name: 'Vidence BETA',
    short_name: 'Vidence',
    description:
      '边看视频边建立本地记忆库：记录字幕与关键画面，可检索、可选中节点向 AI 提问。',
    version: '0.1.0.4',
    version_name: '0.1.0 BETA.4',
    icons: { 16: 'brand/icon-16.png', 32: 'brand/icon-32.png', 48: 'brand/icon-48.png', 128: 'brand/icon-128.png' },
    minimum_chrome_version: '116',
    sandbox: { pages: ['sandbox.html'] },
    content_security_policy: {
      sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; child-src 'self' blob:; connect-src 'self' chrome-extension: blob: data:;",
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    permissions: [
      'storage',
      'unlimitedStorage',
      'sidePanel',
      'offscreen',
      'tabs',
      'activeTab',
      'scripting',
      'alarms',
    ],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: 'Vidence',
      default_icon: { 16: 'brand/icon-16.png', 32: 'brand/icon-32.png', 48: 'brand/icon-48.png', 128: 'brand/icon-128.png' },
    },
    options_ui: {
      page: 'library.html',
      open_in_tab: true,
    },
    web_accessible_resources: [
      {
        resources: [
          'sidepanel.html',
          'library.html',
          'offscreen.html',
          'models/*',
          'ocr/*',
          'ort/*',
          'ort-transformers/*',
          'chunks/*',
          'assets/*',
          'brand/*',
        ],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
    build: {
      // transformers.js / onnxruntime wasm 需要较大的 chunk 体积上限
      chunkSizeWarningLimit: 8192,
    },
    optimizeDeps: {
      exclude: ['@huggingface/transformers', '@paddleocr/paddleocr-js'],
    },
  }),
});
