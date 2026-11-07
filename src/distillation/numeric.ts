import type { Fact } from './schema.ts';
import { conditionNumber, unitValue } from './conditions.ts';

/**
 * Explicit numeric types for preparation conditions.
 *
 * The model writes natural language; a filter must not turn "350–400 °C" into 375 °C or
 * "≥ 400 °C" into 400 °C. Every value keeps its original text and reports what is actually
 * known: a point, a range, one-sided bounds, an approximation or a temperature programme.
 */

export type NumericKind = 'single' | 'range' | 'lower' | 'upper' | 'approximate' | 'program' | 'unparsed';
export type Quantity = 'temperature' | 'duration';

export interface NumericValue {
  kind: NumericKind;
  raw: string;
  unit: string | null;
  /** Canonical unit: °C for temperature, seconds for duration. */
  single?: number;
  min?: number;
  max?: number;
  approximate?: number;
  exclusive?: boolean;
  program?: { value: number; hold_seconds: number | null }[];
  text: string;
}

// Non-capturing sources so nested patterns do not shift match indices.
const TEMPERATURE_UNIT_SOURCE = String.raw`(?:°c|℃|ºc|◦c|(?<![a-z])c(?![a-z])|\bk\b|kelvin|°f|fahrenheit)`;
const DURATION_UNIT_SOURCE = String.raw`(?:\bseconds?\b|\bsecs?\b|\bsec\b|\bminutes?\b|\bmins?\b|\bmin\b|\bhours?\b|\bhrs?\b|\bhr\b|\bh\b|\bdays?\b|\bd\b|\bs\b|秒|分钟|小时|天)`;
const unitPattern = (quantity: Quantity) => new RegExp(quantity === 'temperature' ? TEMPERATURE_UNIT_SOURCE : DURATION_UNIT_SOURCE, 'i');

const numberPattern = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const rangeSeparator = String.raw`(?:-|–|—|~|to|至|到)`;

const rawOf = (fact: Fact): string => {
  if (typeof fact.raw === 'string' && fact.raw.trim()) return fact.raw.trim();
  if (typeof fact.value === 'string' && fact.value.trim()) return fact.value.trim();
  if (typeof fact.value === 'number') return String(fact.value);
  return '';
};

const detectUnit = (text: string, quantity: Quantity, fallback: string | null): string | null => {
  const match = unitPattern(quantity).exec(text);
  return match?.[0] ?? fallback;
};

const convert = (value: number, unit: string | null, quantity: Quantity): number | null => {
  if (!unit) return null;
  const converted = unitValue(value, unit, quantity);
  return converted === null || !Number.isFinite(converted) ? null : Number(converted.toFixed(6));
};

/** Parse a temperature programme such as `200 °C 1 h → 400 °C 2 h`. */
function parseProgram(text: string, quantity: Quantity, unit: string | null): NumericValue | null {
  const hasProgramMarker = /(→|->|then|ramp|program|程序|升温|分段)/i.test(text);
  const unitSource = unitPattern(quantity).source;
  const tokens = [...text.matchAll(new RegExp(`(${numberPattern})\\s*(${unitSource})`, 'gi'))]
    .filter(match => !/^\s*\/\s*(min|h|s|分钟|小时)/i.test(text.slice((match.index ?? 0) + match[0].length)));
  if (!hasProgramMarker || quantity !== 'temperature') return null;
  if (quantity === 'temperature' && tokens.length < 2) return null;
  const pair = new RegExp(`(${numberPattern})\\s*(${unitSource})\\s*(?:for|hold(?:ing)?|保温|保持)?\\s*(${numberPattern})?\\s*(${DURATION_UNIT_SOURCE})?`, 'gi');
  const program: { value: number; hold_seconds: number | null }[] = [];
  for (const match of text.matchAll(pair)) {
    if (/^\s*\/\s*(min|h|s|分钟|小时)/i.test(text.slice((match.index ?? 0) + match[0].length))) continue;
    const value = convert(Number(match[1]), match[2] ?? unit, quantity);
    if (value === null) continue;
    const hold = match[3] && match[4] ? convert(Number(match[3]), match[4], 'duration') : null;
    program.push({ value, hold_seconds: hold });
  }
  if (program.length < 2) return null;
  return {
    kind: 'program', raw: text, unit, program,
    max: Math.max(...program.map(item => item.value)),
    min: Math.min(...program.map(item => item.value)),
    text,
  };
}

/**
 * Parse a stored condition. Returns null when the fact is not reported or the value cannot
 * be interpreted; callers must treat that as unknown, never as a default.
 */
export function parseQuantity(fact: Fact, quantity: Quantity): NumericValue | null {
  if (fact.status !== 'reported') return null;
  const original = rawOf(fact);
  const text = original.replace(/−/g, '-');
  if (!text) return null;
  const unit = detectUnit(text, quantity, fact.unit);

  const rangeEach = new RegExp(`(${numberPattern})\\s*(${unitPattern(quantity).source})\\s*${rangeSeparator}\\s*(${numberPattern})\\s*(${unitPattern(quantity).source})`, 'i').exec(text);
  const rangePlain = new RegExp(`(${numberPattern})\\s*${rangeSeparator}\\s*(${numberPattern})\\s*(${unitPattern(quantity).source})?`, 'i').exec(text);
  const range = rangeEach
    ? { low: Number(rangeEach[1]), high: Number(rangeEach[3]), unit: rangeEach[2], highUnit: rangeEach[4] }
    : rangePlain && !/[/]/.test(text.slice((rangePlain.index ?? 0) + rangePlain[0].length, (rangePlain.index ?? 0) + rangePlain[0].length + 2))
      ? { low: Number(rangePlain[1]), high: Number(rangePlain[2]), unit: rangePlain[3] ?? unit, highUnit: rangePlain[3] ?? unit }
      : null;
  if (range && Number.isFinite(range.low) && Number.isFinite(range.high)) {
    const low = convert(range.low, range.unit, quantity);
    const high = convert(range.high, range.highUnit, quantity);
    if (low !== null && high !== null && low <= high) {
      return { kind: 'range', raw: original, unit: range.unit ?? unit, min: Math.min(low, high), max: Math.max(low, high), text };
    }
  }

  const program = parseProgram(text, quantity, unit);
  if (program) return { ...program, raw: original };

  const lower = new RegExp(`(?:>=|≥|不低于|至少|不小于|at least|no less than|above|over|higher than|(?<!no )more than|>)\\s*(${numberPattern})`, 'i').exec(text);
  if (lower) {
    const value = convert(Number(lower[1]), unit, quantity);
    if (value !== null) return { kind: 'lower', raw: original, unit, exclusive: /^(?:>(?!=)|above|over|higher than|more than)/i.test(lower[0]), min: value, text };
  }
  const upper = new RegExp(`(?:<=|≤|不高于|不超过|最多|至多|at most|no more than|below|under|lower than|less than|<)\\s*(${numberPattern})`, 'i').exec(text);
  if (upper) {
    const value = convert(Number(upper[1]), unit, quantity);
    if (value !== null) return { kind: 'upper', raw: original, unit, exclusive: /^(?:<(?!=)|below|under|lower than|less than)/i.test(upper[0]), max: value, text };
  }
  const approximate = new RegExp(`(?:~|约|大约|大概|about|approximately|around|ca\\.)\\s*(${numberPattern})`, 'i').exec(text)
    ?? new RegExp(`(${numberPattern})\\s*(?:左右|approx\\.?)`, 'i').exec(text);
  if (approximate) {
    const value = convert(Number(approximate[1]), unit, quantity);
    if (value !== null) return { kind: 'approximate', raw: original, unit, single: value, approximate: value, text };
  }

  // A ramp states the target temperature but not the hold time: the maximum is known, duration is not.
  const ramp = new RegExp(`(?:to|至|到)\\s*(${numberPattern})\\s*(${unitPattern('temperature').source})`, 'i').exec(text);
  if (ramp && quantity === 'temperature' && /(°c|℃)\s*\/\s*(min|h|s)/i.test(text)) {
    const value = convert(Number(ramp[1]), ramp[2], 'temperature');
    if (value !== null) return { kind: 'program', raw: original, unit, program: [{ value, hold_seconds: null }], min: value, max: value, text };
  }
  if (quantity === 'duration') {
    const article = /(?:\ba\b|\ban\b|\bone\b)\s*(day|hour|minute|second|天|小时|分钟|秒)/i.exec(text);
    if (article) {
      const value = convert(1, article[1], 'duration');
      if (value !== null) return { kind: 'single', raw: original, unit: article[1], single: value, text };
    }
  }

  const single = conditionNumber(fact, quantity);
  if (single) return { kind: 'single', raw: original, unit, single: single.value, text };
  return { kind: 'unparsed', raw: original, unit, text };
}

/** The largest value this step can have, or null when it is only bounded from below. */
export const upperBound = (value: NumericValue | null): number | null => {
  if (!value || value.kind === 'approximate') return null;
  if (value.max !== undefined) return value.max;
  if (value.single !== undefined) return value.single;
  if (value.program) return Math.max(...value.program.map(item => item.value));
  return null;
};

/** The smallest value this step must have, or null when it is only bounded from above. */
export const lowerBound = (value: NumericValue | null): number | null => {
  if (!value || value.kind === 'approximate') return null;
  if (value.min !== undefined) return value.min;
  if (value.single !== undefined) return value.single;
  if (value.program) return Math.min(...value.program.map(item => item.value));
  return null;
};

/** Total hold time of a programme, or null when any hold is unstated. */
export const programHoldSeconds = (value: NumericValue | null): number | null => {
  if (!value?.program) return null;
  if (value.program.some(item => item.hold_seconds === null)) return null;
  return value.program.reduce((sum, item) => sum + (item.hold_seconds ?? 0), 0);
};
