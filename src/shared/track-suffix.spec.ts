import { describe, expect, it } from 'vitest';
import { trackSuffix } from './track-suffix';

describe('trackSuffix', () => {
  const song = 'Été 日本.v2.mp3';

  it('is the file name without its extension, unless another is chosen', () => {
    expect(trackSuffix(null, song)).toBe('Été 日本.v2');
    expect(trackSuffix('', song)).toBe('Été 日本.v2');
    expect(trackSuffix(' \t ', song)).toBe('Été 日本.v2');
    expect(trackSuffix('Plage 🌊', song)).toBe('Plage 🌊');
    // As Node's `path.parse` has it: a leading dot does not start an extension.
    expect(trackSuffix('', '.mp3')).toBe('.mp3');
    expect(trackSuffix('', 'no extension')).toBe('no extension');
  });

  it('makes a space of what file names cannot hold', () => {
    expect(trackSuffix('a<b>c:d"e/f\\g|h?i*j', song)).toBe('a b c d e f g h i j');
    expect(trackSuffix('line\nbreak\u0000end\u007F\u0085', song)).toBe('line break end');
    expect(trackSuffix('  many   spaces   ', song)).toBe('many spaces');
    expect(trackSuffix('???', song)).toBe('Été 日本.v2');
    // The file name is cleaned the same way.
    expect(trackSuffix('', 'Live: Paris?.mp3')).toBe('Live Paris');
    // Nothing left of the file name either.
    expect(trackSuffix('', '?.mp3')).toBe('new audio');
  });

  it('leaves out direction marks, which would show the end of the name reversed', () => {
    expect(trackSuffix('evil‮gpj.exe', song)).toBe('evilgpj.exe');
    expect(trackSuffix('⁧a⁩‎‏؜', song)).toBe('a');
  });

  it('is at most 120 bytes long, cut between characters', () => {
    expect(trackSuffix('a'.repeat(200), song)).toBe('a'.repeat(120));
    // 2 bytes each: 60 fit.
    expect(trackSuffix('é'.repeat(100), song)).toBe('é'.repeat(60));
    // 4 bytes each: 30 fit.
    expect(trackSuffix('🌊'.repeat(40), song)).toBe('🌊'.repeat(30));
    // 3 bytes each: the next one does not fit after the space, which is trimmed.
    expect(trackSuffix(`${'日'.repeat(39)} 本本`, song)).toBe('日'.repeat(39));
    // A flag is 8 bytes: one that does not fit whole is left out.
    expect(trackSuffix(`${'a'.repeat(115)}🇫🇷`, song)).toBe('a'.repeat(115));
    // So is a family of 25 bytes, joined by zero-width joiners.
    expect(trackSuffix(`${'a'.repeat(100)}👨‍👩‍👧‍👦`, song)).toBe('a'.repeat(100));
    expect(trackSuffix(`${'a'.repeat(95)}👨‍👩‍👧‍👦`, song)).toBe(`${'a'.repeat(95)}👨‍👩‍👧‍👦`);
    // The file name too.
    expect(trackSuffix('', `${'b'.repeat(130)}.mp3`)).toBe('b'.repeat(120));
  });
});
