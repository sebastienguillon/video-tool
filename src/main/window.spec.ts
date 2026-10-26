import type { BrowserWindow, WindowSessionEndEvent } from 'electron';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guardSessionEnd, originOf } from './window';

vi.mock('electron', () => ({ BrowserWindow: {}, nativeTheme: {} }));

describe('originOf', () => {
  it('gives the scheme and host of the app and of the dev server', () => {
    expect(originOf('app://bundle/index.html')).toBe('app://bundle');
    expect(originOf('APP://Bundle/settings?x=1')).toBe('app://bundle');
    expect(originOf('http://localhost:4318/')).toBe('http://localhost:4318');
  });

  it('tells other pages apart, where URL.origin would say "null" for all of them', () => {
    const app = originOf('app://bundle/');
    for (const url of [
      'file:///C:/Users/Seb/Vid%C3%A9os/clip.mp4',
      'file:///home/seb/clip.mp4',
      'data:text/html,<p>hi</p>',
      'about:blank',
      'app://other/',
      'http://localhost:4200/',
    ]) {
      expect(originOf(url), url).not.toBe(app);
    }
    expect(originOf('not a url')).toBeNull();
  });
});

describe('guardSessionEnd', () => {
  it('asks Windows to wait while busy, then cleans up as the session ends', () => {
    const window = new EventEmitter();
    let busy = true;
    const end = vi.fn();
    guardSessionEnd(window as unknown as BrowserWindow, { busy: () => busy, end });
    /** Whether the handler asked Windows to wait. */
    const emit = (name: 'query-session-end' | 'session-end'): boolean => {
      const preventDefault = vi.fn();
      const event: Partial<WindowSessionEndEvent> = { reasons: ['shutdown'], preventDefault };
      window.emit(name, event);
      return preventDefault.mock.calls.length > 0;
    };

    expect(emit('query-session-end')).toBe(true);
    busy = false;
    expect(emit('query-session-end')).toBe(false);
    expect(end).not.toHaveBeenCalled();

    expect(emit('session-end')).toBe(false);
    expect(end).toHaveBeenCalledOnce();
  });
});
