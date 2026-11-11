import { createRoot } from 'react-dom/client';
import { installDesktopRuntime, type NativeBridge } from '@/desktop/runtime';
import DesktopApp from './DesktopApp';
import '@/ui/theme.css';
import { UiLocaleProvider } from '@/ui/i18n';

declare global { interface Window { qt?: { webChannelTransport: unknown }; __vmaTestNative?: NativeBridge; QWebChannel: new (transport: unknown, callback: (channel: { objects: { native: NativeBridge } }) => void) => unknown } }
if (!window.qt) document.getElementById('root')!.textContent = '请使用“启动Vidence”打开独立应用。';
else new window.QWebChannel(window.qt.webChannelTransport, channel => {
  if (new URLSearchParams(location.search).get('debug') === '1') window.__vmaTestNative = channel.objects.native;
  void installDesktopRuntime(channel.objects.native).then(() => createRoot(document.getElementById('root')!).render(<UiLocaleProvider native={channel.objects.native}><DesktopApp native={channel.objects.native}/></UiLocaleProvider>)).catch(error => { document.getElementById('root')!.textContent = `启动失败：${error.message}`; });
});
