import type { AddResult } from '@shared/model';
import { describeAdd, NoticeBoard } from './notice';

const result = (
  added: number,
  duplicates: number,
  ignored: number,
  truncated = false,
): AddResult => ({
  added,
  duplicates,
  ignored,
  truncated,
});

describe('describeAdd', () => {
  it('sums up what was added, what was there already and what was ignored', () => {
    expect(describeAdd(result(3, 1, 2), 'videos')).toBe(
      '3 videos added · 1 already in the list · 2 files ignored: not videos',
    );
    expect(describeAdd(result(1, 0, 1), 'videos')).toBe(
      '1 video added · 1 file ignored: not a video',
    );
    expect(describeAdd(result(0, 2, 0), 'videos')).toBe('2 already in the list');
  });

  it('says when nothing was found, as in a folder without videos', () => {
    expect(describeAdd(result(0, 0, 0), 'videos')).toBe('No videos found.');
  });

  it('counts dropped items that are not files on this computer as ignored', () => {
    expect(describeAdd(result(2, 0, 0), 'videos', 1)).toBe(
      '2 videos added · 1 file ignored: not a video',
    );
  });

  it('says when folders held more videos than one drop takes, and what to do about it', () => {
    expect(describeAdd(result(4_990, 10, 0, true), 'videos')).toBe(
      '4,990 videos added · 10 already in the list · stopped at 5,000 videos from folders: drop the rest separately',
    );
    // The same folder dropped again: its first videos are in the list already.
    expect(describeAdd(result(0, 5_000, 0, true), 'videos')).toBe(
      '5,000 already in the list · stopped at 5,000 videos from folders: drop the rest separately',
    );
  });

  it('speaks of audio files for the audio list', () => {
    expect(describeAdd(result(2, 0, 3), 'tracks')).toBe(
      '2 audio files added · 3 files ignored: not audio',
    );
    expect(describeAdd(result(1, 0, 0), 'tracks')).toBe('1 audio file added');
  });
});

describe('NoticeBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets information go after a while, and keeps warnings and errors until the next message', () => {
    const board = new NoticeBoard();
    board.info('3 videos added');
    expect(board.notice()).toEqual({ text: '3 videos added', tone: 'info' });
    vi.advanceTimersByTime(8_000);
    expect(board.notice()).toBeNull();

    board.error('Cannot clear the list: the disk is gone.');
    vi.advanceTimersByTime(60_000);
    expect(board.notice()?.tone).toBe('error');

    board.info('1 video added');
    board.error('Cannot add the videos: no.');
    vi.advanceTimersByTime(8_000);
    expect(board.notice()?.text).toBe('Cannot add the videos: no.');

    board.info('1 video added');
    board.warning('5,000 videos added · stopped at 5,000 videos from folders');
    vi.advanceTimersByTime(60_000);
    expect(board.notice()?.tone).toBe('warning');
  });
});
