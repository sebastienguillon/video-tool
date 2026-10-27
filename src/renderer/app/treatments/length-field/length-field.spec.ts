import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { Trim } from '@shared/model';
import { text } from '../../testing/fake-desktop';
import { formatLength, LengthField, parseLength } from './length-field';

describe('LengthField', () => {
  let fixture: ComponentFixture<LengthField>;
  let host: HTMLElement;
  let validity: boolean[];

  beforeEach(async () => {
    fixture = TestBed.createComponent(LengthField);
    host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('label', 'Remove from the start');
    fixture.componentRef.setInput('value', { amount: 0, unit: 'seconds' } satisfies Trim);
    validity = [];
    fixture.componentInstance.validityChange.subscribe((valid) => validity.push(valid));
    await fixture.whenStable();
  });

  const input = (): HTMLInputElement => host.querySelector('input') as HTMLInputElement;
  const select = (): HTMLSelectElement => host.querySelector('select') as HTMLSelectElement;
  const hint = (): string => text(host.querySelector('.hint'));
  const value = (): Trim => fixture.componentInstance.value();
  const type = async (typed: string): Promise<void> => {
    input().value = typed;
    input().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const leave = async (): Promise<void> => {
    input().dispatchEvent(new Event('blur'));
    await fixture.whenStable();
  };
  const switchTo = async (unit: string): Promise<void> => {
    select().value = unit;
    select().dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };

  it('is labelled, shows 0 as a placeholder and gives an example', () => {
    expect(text(host.querySelector('label'))).toBe('Remove from the start');
    expect(host.querySelector('label')?.getAttribute('for')).toBe(input().id);
    expect(input().value).toBe('');
    expect(input().placeholder).toBe('0');
    expect(input().getAttribute('aria-describedby')).toBe(host.querySelector('.hint')?.id);
    expect(hint()).toBe('e.g. 2.5 or 1:02.5');
    expect(select().getAttribute('aria-label')).toBe('Remove from the start: unit');
  });

  it('says it is valid once created: a field shown again starts with its value', () => {
    expect(validity).toEqual([true]);
  });

  it('changes the value as soon as the text reads as a length, and writes it back on leaving', async () => {
    await type('1:5');
    expect(value()).toEqual({ amount: 65, unit: 'seconds' });
    expect(input().value).toBe('1:5');
    await leave();
    expect(input().value).toBe('1:05');

    await type('2,5');
    expect(value()).toEqual({ amount: 2.5, unit: 'seconds' });
    await leave();
    expect(input().value).toBe('2.5');

    await type('0');
    await leave();
    expect(value().amount).toBe(0);
    expect(input().value).toBe('');
  });

  it('says when the text is not a length, keeping the last valid one meanwhile', async () => {
    await type('2.5');
    await type('2.5 sec');
    expect(value()).toEqual({ amount: 2.5, unit: 'seconds' });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(hint()).toBe('Enter seconds, like 2.5 or 1:02.5.');
    expect(host.querySelector('.hint')?.classList).toContain('error-text');
    await leave();
    expect(input().value).toBe('2.5 sec');

    await type('3');
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(value().amount).toBe(3);
    expect(validity).toEqual([true, false, true]);
  });

  it('takes whole numbers of frames', async () => {
    await switchTo('frames');
    expect(hint()).toBe('A whole number, e.g. 12');
    expect(input().getAttribute('inputmode')).toBe('numeric');
    await type('12');
    expect(value()).toEqual({ amount: 12, unit: 'frames' });
    await type('12.5');
    expect(hint()).toBe('Enter a whole number of frames.');
    expect(value().amount).toBe(12);
  });

  it('converts nothing when the unit changes: the number stays if it fits, otherwise it is 0', async () => {
    await type('12');
    await switchTo('frames');
    expect(value()).toEqual({ amount: 12, unit: 'frames' });
    expect(input().value).toBe('12');

    await switchTo('seconds');
    await type('2.5');
    await switchTo('frames');
    expect(value()).toEqual({ amount: 0, unit: 'frames' });
    expect(input().value).toBe('');
  });

  it('keeps a number written in minutes on leaving the field for the unit menu', async () => {
    await type('90');
    await leave();
    expect(input().value).toBe('1:30');
    await switchTo('frames');
    expect(value()).toEqual({ amount: 90, unit: 'frames' });
    expect(input().value).toBe('90');

    await switchTo('seconds');
    await leave();
    expect(value()).toEqual({ amount: 90, unit: 'seconds' });
    expect(input().value).toBe('1:30');
  });

  it('reads text that is no length in the old unit in the new one', async () => {
    await switchTo('frames');
    await type('12.5');
    await switchTo('seconds');
    expect(value()).toEqual({ amount: 12.5, unit: 'seconds' });
    expect(input().getAttribute('aria-invalid')).toBe('false');
  });

  it('becomes valid again when switching units resets invalid text', async () => {
    await type('abc');
    await switchTo('frames');
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(validity).toEqual([true, false, true]);
  });

  it('shows a value set from outside, as when the settings load', async () => {
    fixture.componentRef.setInput('value', { amount: 62.25, unit: 'seconds' } satisfies Trim);
    await fixture.whenStable();
    expect(input().value).toBe('1:02.25');
    expect(select().value).toBe('seconds');

    fixture.componentRef.setInput('value', { amount: 24, unit: 'frames' } satisfies Trim);
    await fixture.whenStable();
    expect(input().value).toBe('24');
    expect(select().value).toBe('frames');
    expect(hint()).toBe('A whole number, e.g. 12');
  });
});

describe('parseLength and formatLength', () => {
  it('read and write lengths in each unit', () => {
    expect(parseLength('1:02:03.5', 'seconds')).toBe(3723.5);
    expect(parseLength('', 'frames')).toBe(0);
    expect(parseLength('-3', 'frames')).toBeNull();
    expect(formatLength({ amount: 3723.5, unit: 'seconds' })).toBe('1:02:03.5');
    expect(formatLength({ amount: 48, unit: 'frames' })).toBe('48');
    expect(formatLength({ amount: 0, unit: 'frames' })).toBe('');
  });
});
