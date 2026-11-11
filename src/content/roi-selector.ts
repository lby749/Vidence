/**
 * 手动框选字幕区域：覆盖在视频上的拖拽选择层。
 * 只用于用户主动修正 ROI，不读取页面其他内容。
 */

import type { NormRect } from '@/shared/types';

export function selectRoiInteractive(video: HTMLVideoElement): Promise<NormRect | null> {
  return new Promise((resolve) => {
    const videoRect = video.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; left: ${videoRect.left}px; top: ${videoRect.top}px;
      width: ${videoRect.width}px; height: ${videoRect.height}px;
      z-index: 2147483646; cursor: crosshair; background: rgba(0,0,0,0.28);
      font: 13px/1.5 system-ui, sans-serif; color: #fff; user-select: none;
    `;
    const hint = document.createElement('div');
    hint.textContent = '拖动框选字幕区域，Esc 或点右侧按钮取消';
    hint.style.cssText =
      'position:absolute;left:8px;top:8px;padding:4px 8px;background:rgba(0,0,0,.6);border-radius:4px;pointer-events:none;';
    overlay.appendChild(hint);

    // 明确的取消按钮：键盘焦点不在顶层页面时 Esc 可能收不到
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.style.cssText =
      'position:absolute;right:8px;top:8px;padding:4px 10px;border:0;border-radius:4px;background:#fff;color:#26221e;cursor:pointer;font:13px/1.4 system-ui,sans-serif;';
    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      resolve(null);
    });
    overlay.appendChild(cancel);

    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;border:2px solid #ffd166;background:rgba(255,209,102,.18);display:none;pointer-events:none;';
    overlay.appendChild(box);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };

    overlay.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      startX = event.clientX - rect.left;
      startY = event.clientY - rect.top;
      dragging = true;
      box.style.display = 'block';
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = '0px';
      box.style.height = '0px';
      overlay.setPointerCapture(event.pointerId);
    });

    overlay.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = overlay.getBoundingClientRect();
      const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
      const y = Math.min(Math.max(0, event.clientY - rect.top), rect.height);
      box.style.left = `${Math.min(startX, x)}px`;
      box.style.top = `${Math.min(startY, y)}px`;
      box.style.width = `${Math.abs(x - startX)}px`;
      box.style.height = `${Math.abs(y - startY)}px`;
    });

    overlay.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = overlay.getBoundingClientRect();
      const left = parseFloat(box.style.left);
      const top = parseFloat(box.style.top);
      const width = parseFloat(box.style.width);
      const height = parseFloat(box.style.height);
      cleanup();
      if (width < 40 || height < 16) {
        resolve(null);
        return;
      }
      resolve({
        x: left / rect.width,
        y: top / rect.height,
        w: width / rect.width,
        h: height / rect.height,
      });
    });

    document.addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(overlay);
    // 让当前文档获得焦点，Esc 才能稳定传到本监听器
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      overlay.tabIndex = -1;
      overlay.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  });
}
