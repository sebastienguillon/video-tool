import type { ZoomWheel } from '@shared/desktop-api';
import { IpcChannel } from '@shared/desktop-api';
import type { Input, WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ZoomKey } from './zoom';
import {
  handleZoom,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  steppedZoomLevel,
  WheelZoom,
  ZOOM_STEP,
  zoomKey,
} from './zoom';

type KeyInput = Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt'>;

function key(character: string, modifiers: Partial<KeyInput> = {}): KeyInput {
  return { type: 'keyDown', key: character, control: false, meta: false, alt: false, ...modifiers };
}

describe('zoomKey', () => {
  it('reads keys as the characters they type, wherever the layout puts them', () => {
    const expected: Record<string, ZoomKey> = { '+': 'in', '=': 'in', '-': 'out', '0': 'reset' };
    for (const [character, zoom] of Object.entries(expected)) {
      expect(zoomKey(key(character, { control: true }), 'win32'), character).toBe(zoom);
      expect(zoomKey(key(character, { control: true }), 'linux'), character).toBe(zoom);
      expect(zoomKey(key(character, { meta: true }), 'darwin'), character).toBe(zoom);
    }
  });

  it('wants Cmd on macOS and Ctrl elsewhere', () => {
    expect(zoomKey(key('+', { control: true }), 'darwin')).toBeNull();
    expect(zoomKey(key('+', { meta: true }), 'win32')).toBeNull();
    expect(zoomKey(key('+'), 'win32')).toBeNull();
  });

  it('leaves other keys, key releases and AltGr alone', () => {
    expect(zoomKey(key('o', { control: true }), 'win32')).toBeNull();
    expect(zoomKey(key('_', { control: true }), 'win32')).toBeNull();
    expect(zoomKey(key('-', { control: true, type: 'keyUp' }), 'win32')).toBeNull();
    expect(zoomKey(key('=', { control: true, alt: true }), 'win32')).toBeNull();
  });
});

describe('steppedZoomLevel', () => {
  it('moves by half a level per step', () => {
    expect(steppedZoomLevel(0, 1)).toBe(ZOOM_STEP);
    expect(steppedZoomLevel(0, -2)).toBe(-2 * ZOOM_STEP);
  });

  it('stops at the limits', () => {
    expect(steppedZoomLevel(MAX_ZOOM_LEVEL - ZOOM_STEP, 3)).toBe(MAX_ZOOM_LEVEL);
    expect(steppedZoomLevel(MIN_ZOOM_LEVEL, -1)).toBe(MIN_ZOOM_LEVEL);
  });

  it('never moves the other way from beyond them', () => {
    expect(steppedZoomLevel(MAX_ZOOM_LEVEL + 2, 1)).toBe(MAX_ZOOM_LEVEL + 2);
    expect(steppedZoomLevel(MAX_ZOOM_LEVEL + 2, -1)).toBe(MAX_ZOOM_LEVEL + 2 - ZOOM_STEP);
    expect(steppedZoomLevel(MIN_ZOOM_LEVEL - 2, -1)).toBe(MIN_ZOOM_LEVEL - 2);
    expect(steppedZoomLevel(MIN_ZOOM_LEVEL - 2, 1)).toBe(MIN_ZOOM_LEVEL - 2 + ZOOM_STEP);
  });
});

describe('WheelZoom', () => {
  const scroll = (wheelDeltaY: number): ZoomWheel => ({
    pinch: false,
    deltaY: -wheelDeltaY,
    wheelDeltaY,
  });

  it('zooms a step per notch of a mouse wheel, however zoomed the page is', () => {
    const wheel = new WheelZoom();
    expect(wheel.steps(scroll(120), 1)).toBe(1);
    expect(wheel.steps(scroll(-120), 1)).toBe(-1);
    // At level 2 (144%), Chromium gives 120 / 1.44, as a whole number: 83.
    for (let notch = 0; notch < 5; notch++) {
      expect(wheel.steps(scroll(83), 1.44)).toBe(1);
    }
  });

  it('adds up the small deltas of a trackpad', () => {
    const wheel = new WheelZoom();
    let steps = 0;
    // A quarter of a notch at a time.
    for (let event = 0; event < 8; event++) {
      steps += wheel.steps(scroll(30), 1);
    }
    expect(steps).toBe(2);
  });

  it('follows a pinch, by as much as the fingers spread or close', () => {
    const wheel = new WheelZoom();
    let level = 0;
    /** Pinches to `scale` in 20 events, as Chromium reports them to a page at `level`. */
    const pinch = (scale: number): void => {
      for (let event = 0; event < 20; event++) {
        const zoomFactor = 1.2 ** level;
        const steps = wheel.steps(
          {
            pinch: true,
            deltaY: (-100 * Math.log(scale ** (1 / 20))) / zoomFactor,
            // One notch per event, whatever the scale: not what a pinch zooms by.
            wheelDeltaY: (scale > 1 ? 120 : -120) / zoomFactor,
          },
          zoomFactor,
        );
        level += steps * ZOOM_STEP;
      }
    };

    pinch(2);
    // 2 times is 3.8 levels: as close as half-level steps get.
    expect(Math.abs(level - Math.log(2) / Math.log(1.2))).toBeLessThanOrEqual(ZOOM_STEP / 2);
    pinch(1 / 2);
    expect(level).toBeCloseTo(0);
  });
});

describe('handleZoom', () => {
  const APP = 'app://bundle/';

  class FakeContents extends EventEmitter {
    zoomLevel = 0;
    readonly ipc = new EventEmitter();

    get zoomFactor(): number {
      return 1.2 ** this.zoomLevel;
    }
  }

  function setUp(): FakeContents {
    const contents = new FakeContents();
    handleZoom(contents as unknown as WebContents, {
      platform: 'win32',
      isTrusted: (url) => url === APP,
    });
    return contents;
  }

  it('zooms on the keys, which neither the menu nor the page then see', () => {
    const contents = setUp();
    /** Whether the key was kept from the menu and the page. */
    const press = (input: KeyInput): boolean => {
      const preventDefault = vi.fn();
      contents.emit('before-input-event', { preventDefault }, input);
      return preventDefault.mock.calls.length > 0;
    };

    expect(press(key('+', { control: true }))).toBe(true);
    expect(contents.zoomLevel).toBe(ZOOM_STEP);
    press(key('-', { control: true }));
    press(key('-', { control: true }));
    expect(contents.zoomLevel).toBe(-ZOOM_STEP);
    expect(press(key('0', { control: true }))).toBe(true);
    expect(contents.zoomLevel).toBe(0);

    expect(press(key('o', { control: true }))).toBe(false);
    expect(press(key('-'))).toBe(false);
    expect(contents.zoomLevel).toBe(0);
  });

  it('zooms on Ctrl + wheel', () => {
    const contents = setUp();
    contents.emit('zoom-changed', {}, 'in');
    contents.emit('zoom-changed', {}, 'in');
    contents.emit('zoom-changed', {}, 'out');
    expect(contents.zoomLevel).toBe(ZOOM_STEP);
  });

  it('zooms on the wheel events from the preload, of the app only', () => {
    const contents = setUp();
    const send = (payload: unknown, url: string | null = APP): void => {
      contents.ipc.emit(
        IpcChannel.wheelZoom,
        { senderFrame: url === null ? null : { url } },
        payload,
      );
    };
    const notch: ZoomWheel = { pinch: false, deltaY: -100, wheelDeltaY: 120 };

    send(notch);
    expect(contents.zoomLevel).toBe(ZOOM_STEP);

    send(notch, 'http://example.com/');
    send(notch, null);
    send('notch');
    send({ ...notch, pinch: 'no' });
    send({ ...notch, wheelDeltaY: Number.NaN });
    send({ pinch: false, deltaY: -100 });
    expect(contents.zoomLevel).toBe(ZOOM_STEP);
  });
});
