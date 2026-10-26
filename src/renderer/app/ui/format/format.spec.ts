import { info } from '../../testing/fake-desktop';
import { formatFileSize } from './file-size-pipe';
import { describeVideo, formatCodec } from './media';

describe('formatFileSize', () => {
  it('uses decimal units with sensible precision', () => {
    expect(formatFileSize(0, 'en-US')).toBe('0 B');
    expect(formatFileSize(999, 'en-US')).toBe('999 B');
    expect(formatFileSize(1_500, 'en-US')).toBe('1.5 kB');
    expect(formatFileSize(12_340_000, 'en-US')).toBe('12.3 MB');
    expect(formatFileSize(512_000_000, 'en-US')).toBe('512 MB');
    expect(formatFileSize(4_700_000_000, 'en-US')).toBe('4.7 GB');
  });

  it('follows the locale', () => {
    expect(formatFileSize(1_500, 'fr-FR')).toBe('1,5 kB');
  });
});

describe('formatCodec', () => {
  it('uses the names people know, and ffprobe’s otherwise', () => {
    expect(formatCodec('h264')).toBe('H.264');
    expect(formatCodec('pcm_s16le')).toBe('PCM');
    expect(formatCodec('dnxhd')).toBe('dnxhd');
  });
});

describe('describeVideo', () => {
  it('sums up a video in one line', () => {
    expect(describeVideo(info, 'en-US')).toBe(
      '1:05 · 1920×1080 · 29.97 fps · H.264 · AAC · 12.3 MB',
    );
    expect(
      describeVideo(
        { ...info, durationSec: 3725, frameRate: null, videoCodec: 'hevc', audioCodec: null },
        'en-US',
      ),
    ).toBe('1:02:05 · 1920×1080 · HEVC · no audio · 12.3 MB');
  });
});
