import type { ZoomWheel } from '@shared/desktop-api';
import { IpcChannel } from '@shared/desktop-api';
import type { Input, WebContents } from 'electron';
import { isRecord } from './settings-store';

/**
 * Half a zoom level, as Electron's View › Zoom In and Zoom Out: each level is 20% more (1.2 times),
 * and level 0 is 100%.
 */
export const ZOOM_STEP = 0.5;
/** From 48% to 299%: past that, the window is unusable. */
export const MIN_ZOOM_LEVEL = -4;
export const MAX_ZOOM_LEVEL = 6;

/** Chromium's `wheelDeltaY` for one notch of a mouse wheel, at 100%. */
const WHEEL_DELTA_PER_TICK = 120;
/**
 * The `deltaY` of a pinch that zooms by one step, at 100%. Chromium makes a pinch to `scale` a
 * `deltaY` of `-100 * ln(scale)`, so pinching zooms as much as the fingers spread or close.
 */
const PINCH_DELTA_PER_STEP = 100 * Math.log(1.2) * ZOOM_STEP;

export interface ZoomOptions {
  readonly platform: NodeJS.Platform;
  /** Whether a frame at this URL may zoom the page: the app's own pages only. */
  readonly isTrusted: (frameUrl: string) => boolean;
}

/**
 * Zooms the page as browsers do: Ctrl (Cmd on macOS) with +, - or 0, and Ctrl + the mouse wheel;
 * on macOS, Cmd + scrolling and pinching the trackpad.
 *
 * Electron's default menu does have View › Zoom In, Zoom Out and Actual Size, but its shortcuts are
 * keys of a US keyboard: + only with Shift, no numpad, and on Windows no - on a layout that puts it
 * on another key (AZERTY, on the 6). Keys are read here as the characters they type, before the
 * menu sees them. Chromium reports Ctrl + wheel on Windows and Linux (`zoom-changed`), not on
 * macOS: there the preload sends the wheel events that zoom (`IpcChannel.wheelZoom`).
 */
export function handleZoom(contents: WebContents, { platform, isTrusted }: ZoomOptions): void {
  const zoomBy = (steps: number): void => {
    contents.zoomLevel = steppedZoomLevel(contents.zoomLevel, steps);
  };

  contents.on('before-input-event', (event, input) => {
    const key = zoomKey(input, platform);
    if (key === null) {
      return;
    }
    // The menu would zoom a second time on the keys it knows; the page has no use for them.
    event.preventDefault();
    if (key === 'reset') {
      contents.zoomLevel = 0;
    } else {
      zoomBy(key === 'in' ? 1 : -1);
    }
  });

  contents.on('zoom-changed', (_event, direction) => {
    zoomBy(direction === 'in' ? 1 : -1);
  });

  const wheelZoom = new WheelZoom();
  contents.ipc.on(IpcChannel.wheelZoom, (event, payload: unknown) => {
    const wheel = parseZoomWheel(payload);
    if (wheel === null || !isTrusted(event.senderFrame?.url ?? '')) {
      return;
    }
    const steps = wheelZoom.steps(wheel, contents.zoomFactor);
    if (steps !== 0) {
      zoomBy(steps);
    }
  });
}

/** What a key asks of the zoom: in, out, or back to 100%. */
export type ZoomKey = 'in' | 'out' | 'reset';

/**
 * What a key press asks of the zoom, by the character it types: Ctrl (Cmd on macOS) with + or =,
 * - or 0, the numpad's included. `null` for any other key, or with Alt (AltGr is Ctrl + Alt).
 */
export function zoomKey(
  input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt'>,
  platform: NodeJS.Platform,
): ZoomKey | null {
  const modifier = platform === 'darwin' ? input.meta : input.control;
  if (input.type !== 'keyDown' || !modifier || input.alt) {
    return null;
  }
  switch (input.key) {
    case '+':
    case '=':
      return 'in';
    case '-':
      return 'out';
    case '0':
      return 'reset';
    default:
      return null;
  }
}

/**
 * The zoom level `steps` steps from `level` (in when positive), within the limits. It never moves
 * the other way, even from beyond them (where the menu's Zoom In and Zoom Out can take it).
 */
export function steppedZoomLevel(level: number, steps: number): number {
  const stepped = level + steps * ZOOM_STEP;
  return steps > 0
    ? Math.max(level, Math.min(stepped, MAX_ZOOM_LEVEL))
    : Math.min(level, Math.max(stepped, MIN_ZOOM_LEVEL));
}

/**
 * Turns the wheel events of macOS into zoom steps, as Chromium does with Ctrl + wheel elsewhere:
 * one per notch of a mouse wheel, one per notch's worth of scrolling on a trackpad (Chromium counts
 * 40 pixels). A pinch zooms as much as the fingers spread or close.
 */
export class WheelZoom {
  /** Notches, or a pinch, not yet worth a whole step: kept for the next event. */
  private remainder = 0;

  /** Steps to zoom by (in when positive) for `wheel`, sent by a page zoomed by `zoomFactor`. */
  steps(wheel: ZoomWheel, zoomFactor: number): number {
    // The page's deltas shrink as it is zoomed in.
    this.remainder += wheel.pinch
      ? (-wheel.deltaY * zoomFactor) / PINCH_DELTA_PER_STEP
      : (wheel.wheelDeltaY * zoomFactor) / WHEEL_DELTA_PER_TICK;
    // Halves round away from zero, as Chromium does: a notch the zoom left at 119 still counts.
    const whole = Math.round(Math.abs(this.remainder));
    if (whole === 0) {
      return 0;
    }
    const steps = Math.sign(this.remainder) * whole;
    this.remainder -= steps;
    return steps;
  }
}

/** A `ZoomWheel` from the preload; `null` when the payload is not one. */
function parseZoomWheel(payload: unknown): ZoomWheel | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { pinch, deltaY, wheelDeltaY } = payload;
  return typeof pinch === 'boolean' && isFiniteNumber(deltaY) && isFiniteNumber(wheelDeltaY)
    ? { pinch, deltaY, wheelDeltaY }
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
