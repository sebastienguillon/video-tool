import type { OnInit } from '@angular/core';
import { Component, computed, input, linkedSignal, model, output } from '@angular/core';
import type { Trim, TrimUnit } from '@shared/model';
import { formatTime, parseFrames, parseTime } from '@shared/time';

let nextId = 0;

/** A length typed in `unit`; `null` when the text is not one. An empty field is `0`. */
export function parseLength(text: string, unit: TrimUnit): number | null {
  return unit === 'seconds' ? parseTime(text) : parseFrames(text);
}

/** A length as the field shows it; empty for `0`, so that the field shows its `0` placeholder. */
export function formatLength(trim: Trim): string {
  if (trim.amount === 0) {
    return '';
  }
  return trim.unit === 'seconds' ? formatTime(trim.amount) : String(trim.amount);
}

/**
 * A length to trim, in seconds or frames. The value only changes to valid lengths: while the text
 * is not one, the field says so and the value stays the last valid length. Leaving the field writes
 * the length the way it is read (`1:5` becomes `1:05`).
 */
@Component({
  selector: 'app-length-field',
  templateUrl: './length-field.html',
  styleUrl: './length-field.css',
})
export class LengthField implements OnInit {
  readonly label = input.required<string>();
  readonly value = model.required<Trim>();
  /**
   * Emitted when the text starts or stops being a valid length, and once created, valid: a field
   * shown again starts with its value, whatever text it had when it was taken away.
   */
  readonly validityChange = output<boolean>();

  protected readonly id = `length-${nextId++}`;
  protected readonly unit = computed(() => this.value().unit);
  /** The text typed, as long as it reads as the value; otherwise the value, formatted. */
  protected readonly text = linkedSignal<Trim, string>({
    source: this.value,
    computation: (trim, previous) =>
      previous?.source.unit === trim.unit && parseLength(previous.value, trim.unit) === trim.amount
        ? previous.value
        : formatLength(trim),
  });
  protected readonly invalid = computed(() => parseLength(this.text(), this.unit()) === null);
  protected readonly message = computed(() => {
    if (this.unit() === 'seconds') {
      return this.invalid() ? 'Enter seconds, like 2.5 or 1:02.5.' : 'e.g. 2.5 or 1:02.5';
    }
    return this.invalid() ? 'Enter a whole number of frames.' : 'A whole number, e.g. 12';
  });

  ngOnInit(): void {
    this.validityChange.emit(true);
  }

  protected onInput(event: Event): void {
    const wasInvalid = this.invalid();
    const text = (event.target as HTMLInputElement).value;
    this.text.set(text);
    const amount = parseLength(text, this.unit());
    if (amount !== null && amount !== this.value().amount) {
      this.value.set({ amount, unit: this.unit() });
    }
    if (wasInvalid !== this.invalid()) {
      this.validityChange.emit(!this.invalid());
    }
  }

  protected reformat(): void {
    const amount = parseLength(this.text(), this.unit());
    if (amount !== null) {
      this.text.set(formatLength({ amount, unit: this.unit() }));
    }
  }

  /**
   * Nothing is converted: the number stays if it is one in the new unit (whole, for frames),
   * otherwise it is `0`. It is taken from the value, not from the text: leaving the field for the
   * unit menu has just written 90 seconds as `1:30`, which is no number of frames.
   */
  protected setUnit(event: Event): void {
    const unit = (event.target as HTMLSelectElement).value as TrimUnit;
    const wasInvalid = this.invalid();
    // Text that is not a length in the old unit may be one in the new: `12.5` frames.
    const amount = wasInvalid ? parseLength(this.text(), unit) : this.value().amount;
    const kept = amount !== null && (unit === 'seconds' || Number.isSafeInteger(amount));
    this.value.set({ amount: kept ? amount : 0, unit });
    if (wasInvalid) {
      this.validityChange.emit(true);
    }
  }
}
