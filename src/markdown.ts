import type { MarkdownTransformer } from '@earendil-works/pi-coding-agent';

const punctuation = /[\p{P}\p{S}]/u;
const word = /[^\s\p{P}\p{S}]/u;

function spaceBoldBoundaries(text: string): string {
  // Keep the repair narrow: simple, complete ** pairs, without nested emphasis.
  return text.replace(/(?<![\\*])\*\*(?![\s*])([^\r\n*]*[^\s*\\])\*\*(?!\*)/gu,
    (raw: string, body: string, offset: number) => {
      const before = text[offset - 1] ?? '';
      const after = text[offset + raw.length] ?? '';
      const left = word.test(before) && punctuation.test(body[0]) ? ' ' : '';
      const right = punctuation.test(body.at(-1)!) && word.test(after) ? ' ' : '';
      return `${left}${raw}${right}`;
    });
}

export const assistantMarkdownCompatibility: MarkdownTransformer = (markdown, context) => {
  if (context.messageType !== 'assistant' || !markdown.includes('**')) return markdown;
  let fence: { marker: string; length: number } | undefined;
  let inlineTicks = 0;

  return markdown.split(/(?<=\n)/).map(line => {
    // Recognize fences inside block quotes and list items as well as plain fences.
    const content = line.replace(/^(?: {0,3}>[ \t]?)+/, '')
      .replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(content);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      return line;
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { marker: marker[1][0], length: marker[1].length };
      inlineTicks = 0;
      return line;
    }
    if (/^(?: {4}|\t)/.test(content)) return line;

    // Split around code spans; equal backtick runs delimit them, even across lines.
    let result = '';
    let start = 0;
    const ticks = /`+/g;
    for (const match of line.matchAll(ticks)) {
      if (!inlineTicks) {
        // An escaped backtick outside code is literal Markdown text.
        const slashes = /\\*$/.exec(line.slice(0, match.index))![0].length;
        if (slashes % 2) continue;
        result += spaceBoldBoundaries(line.slice(start, match.index)) + match[0];
        inlineTicks = match[0].length;
        start = match.index + match[0].length;
      } else if (match[0].length === inlineTicks) {
        result += line.slice(start, match.index) + match[0];
        inlineTicks = 0;
        start = match.index + match[0].length;
      }
    }
    return result + (inlineTicks ? line.slice(start) : spaceBoldBoundaries(line.slice(start)));
  }).join('');
};
