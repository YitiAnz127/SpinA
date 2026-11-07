/** Small shared formatter for the read-only CLI entry points (demo, review, export, backup). */

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** @param {unknown} value */
export function textWidth(value) {
  let width = 0;
  for (const char of String(value ?? '')) width += WIDE.test(char) ? 2 : 1;
  return width;
}

/** @param {unknown} value @param {number} max */
export function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (textWidth(text) <= max) return text;
  let out = '', width = 0;
  for (const char of text) {
    const next = textWidth(char);
    if (width + next > max - 1) break;
    out += char; width += next;
  }
  return `${out}…`;
}

/** @param {unknown} value @param {number} width */
const pad = (value, width) => `${value}${' '.repeat(Math.max(0, width - textWidth(value)))}`;

/**
 * Aligned plain-text table; CJK characters count as two columns.
 * @param {string[]} headers
 * @param {unknown[][]} rows
 */
export function table(headers, rows) {
  if (!rows.length) return '（无结果）';
  const cells = rows.map(row => row.map(value => String(value ?? '').replace(/\r?\n/g, ' ')));
  const widths = headers.map((header, index) => Math.min(48, Math.max(textWidth(header), ...cells.map(row => textWidth(row[index] ?? '')))));
  /** @param {string[]} values */
  const line = values => values.map((value, index) => pad(truncate(value, widths[index]), widths[index])).join('  ');
  return [line(headers), widths.map(width => '─'.repeat(width)).join('  '), ...cells.map(line)].join('\n');
}

/** @param {string[]} lines */
export function bullet(lines) {
  return lines.filter(Boolean).map(line => `  ${line}`).join('\n');
}

/** @param {unknown} value */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} message @param {number} [code] */
export function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

/**
 * Minimal `--flag value` parser: repeated flags become arrays.
 * @param {string[]} argv
 * @param {{ booleans?: string[], numbers?: string[], repeated?: string[] }} [options]
 */
export function parseFlags(argv, { booleans = [], numbers = [], repeated = [] } = {}) {
  /** @type {Record<string, string | number | boolean | string[]>} */
  const values = {};
  /** @type {string[]} */
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const [rawName, inline] = token.slice(2).split('=', 2);
    const name = rawName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (booleans.includes(name)) {
      values[name] = inline === undefined ? true : inline !== 'false';
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${rawName} 缺少取值`);
    if (numbers.includes(name)) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`--${rawName} 需要数值`);
      values[name] = number;
    } else if (repeated.includes(name)) {
      const list = /** @type {string[]} */ (values[name] ?? []);
      list.push(value);
      values[name] = list;
    } else values[name] = value;
  }
  return { values, positional };
}
