import { describe, expect, it } from 'vitest';
import { formatDuration, formatFrameRate, formatTime, parseFrames, parseTime } from './time';

describe('parseTime', () => {
  it('reads seconds, with a dot or a comma, and an optional unit', () => {
    expect(parseTime('2')).toBe(2);
    expect(parseTime('2.5')).toBe(2.5);
    expect(parseTime('1,5')).toBe(1.5);
    expect(parseTime('.5')).toBe(0.5);
    expect(parseTime('2.')).toBe(2);
    expect(parseTime('2.5s')).toBe(2.5);
    expect(parseTime(' 3 S ')).toBe(3);
    expect(parseTime('90')).toBe(90);
  });

  it('reads minutes:seconds and hours:minutes:seconds', () => {
    expect(parseTime('1:02.5')).toBe(62.5);
    expect(parseTime('1:02')).toBe(62);
    expect(parseTime('90:00')).toBe(5400);
    expect(parseTime('1:02:03.25')).toBe(3723.25);
    expect(parseTime('0:00:00')).toBe(0);
  });

  it('reads an empty field as nothing to trim', () => {
    expect(parseTime('')).toBe(0);
    expect(parseTime('   ')).toBe(0);
  });

  it('rejects what is not a length', () => {
    expect(parseTime('1:75')).toBeNull();
    expect(parseTime('1:60')).toBeNull();
    expect(parseTime('1:60:00')).toBeNull();
    expect(parseTime('-2')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:')).toBeNull();
    expect(parseTime('1::2')).toBeNull();
    expect(parseTime('1.2.3')).toBeNull();
    expect(parseTime('2 m')).toBeNull();
  });
});

describe('parseFrames', () => {
  it('reads whole numbers, and an empty field as zero', () => {
    expect(parseFrames('12')).toBe(12);
    expect(parseFrames(' 7 ')).toBe(7);
    expect(parseFrames('0')).toBe(0);
    expect(parseFrames('')).toBe(0);
  });

  it('rejects fractions, signs, exponents and huge numbers', () => {
    expect(parseFrames('1.5')).toBeNull();
    expect(parseFrames('-1')).toBeNull();
    expect(parseFrames('+1')).toBeNull();
    expect(parseFrames('1e3')).toBeNull();
    expect(parseFrames('abc')).toBeNull();
    expect(parseFrames('99999999999999999999')).toBeNull();
  });
});

describe('formatTime', () => {
  it('writes lengths that parseTime reads back', () => {
    for (const seconds of [0, 0.5, 2, 2.25, 59.999, 62.5, 600, 3600, 3723.25]) {
      expect(parseTime(formatTime(seconds))).toBe(seconds);
    }
  });

  it('uses the shortest clock, with at most three decimals', () => {
    expect(formatTime(0)).toBe('0');
    expect(formatTime(2.5)).toBe('2.5');
    expect(formatTime(62.25)).toBe('1:02.25');
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3723.25)).toBe('1:02:03.25');
    expect(formatTime(1.0004)).toBe('1');
    expect(formatTime(59.9996)).toBe('1:00');
    expect(formatTime(-3)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('writes a clock rounded to the second', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5.4)).toBe('0:05');
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(754)).toBe('12:34');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(-1)).toBe('0:00');
  });
});

describe('formatFrameRate', () => {
  it('keeps up to three decimals', () => {
    expect(formatFrameRate(30)).toBe('30');
    expect(formatFrameRate(30000 / 1001)).toBe('29.97');
    expect(formatFrameRate(24000 / 1001)).toBe('23.976');
  });
});
