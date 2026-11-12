import { expect, it } from 'vitest';
import { isDockMessage } from '@/content/dock';

const frame = {} as Window, other = {} as Window, origin = 'chrome-extension://own-extension';
it.each([
  [frame, origin, true, frame, true],
  [null, origin, true, frame, true], // Privileged extension messages may hide source.
  [null, 'https://video.example', true, frame, false],
  [other, origin, true, frame, false],
  [frame, 'https://video.example', true, frame, false],
  [frame, origin, false, frame, false], // A webpage cannot synthesize a trusted message.
  [null, origin, false, frame, false],
  [null, origin, true, null, false],
] as const)('验证侧栏消息的窗口、扩展来源与可信事件 %s %s %s', (source, sourceOrigin, trusted, expected, allowed) => {
  expect(isDockMessage({ source, origin: sourceOrigin, isTrusted: trusted }, expected, origin)).toBe(allowed);
});
