/** Offscreen 仅转发扩展内部请求；模型在无 chrome API 权限的 sandbox 中运行。 */
import { createComputeClient } from '@/ui/compute-client';
const compute = createComputeClient(chrome.runtime.getURL('sandbox.html'));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return false;
  void compute(message).then(sendResponse);
  return true;
});
