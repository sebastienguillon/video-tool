import { formatDuration, formatFrameRate } from '@shared/time';
import type { VideoInfo } from '@shared/model';
import { formatFileSize } from './file-size-pipe';

/** Names people know, for the ffprobe codec names that come up most. */
const CODEC_NAMES: Readonly<Record<string, string>> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp8: 'VP8',
  vp9: 'VP9',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  prores: 'ProRes',
  theora: 'Theora',
  wmv3: 'WMV',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  alac: 'ALAC',
  wmav2: 'WMA',
};

export function formatCodec(name: string): string {
  return CODEC_NAMES[name] ?? (name.startsWith('pcm_') ? 'PCM' : name);
}

/** One line about a video: `1:05 · 1920×1080 · 29.97 fps · H.264 · AAC · 12.3 MB`. */
export function describeVideo(info: VideoInfo, locale: string): string {
  return [
    formatDuration(info.durationSec),
    `${info.width}×${info.height}`,
    info.frameRate === null ? null : `${formatFrameRate(info.frameRate)} fps`,
    formatCodec(info.videoCodec),
    info.audioCodec === null ? 'no audio' : formatCodec(info.audioCodec),
    formatFileSize(info.sizeBytes, locale),
  ]
    .filter((part) => part !== null)
    .join(' · ');
}
