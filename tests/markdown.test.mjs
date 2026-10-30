import test from 'node:test';
import assert from 'node:assert/strict';
import { Markdown } from '@earendil-works/pi-tui';
import { AssistantMessageComponent } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { assistantMarkdownCompatibility } from '../src/markdown.ts';

const context = { messageType: 'assistant', isStreaming: false, availableWidth: 100 };
const theme = Object.fromEntries([
  'heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote',
  'quoteBorder', 'hr', 'listBullet', 'italic', 'strikethrough', 'underline',
].map(name => [name, text => text]));
theme.bold = text => `\x1b[1m${text}\x1b[22m`;

function render(source, compatible = true) {
  return new Markdown(source, 0, 0, theme, undefined, compatible ? {
    transform: text => assistantMarkdownCompatibility(text, context),
  } : undefined).render(100).join('\n');
}

test('actual Pi renderer displays Chinese bold labels ending in punctuation', () => {
  const source = '**制备方法：**溶胶凝胶法';
  assert.ok(render(source, false).includes('**制备方法：**'));
  assert.ok(render(source).includes('\x1b[1m制备方法：\x1b[22m'));
  assert.ok(!render(source).includes('**'));
  for (const [source, bold] of [
    ['**注意！**保持干燥', '注意！'],
    ['采用**“溶胶凝胶法”**制备', '“溶胶凝胶法”'],
    ['**温度（°C）**为800', '温度（°C）'],
    ['- **温度：**800 °C\n- **时长：**2 h', '时长：'],
    ['| 条件 | 数值 |\n| --- | --- |\n| **温度：**800 | **时长：**2 h |', '时长：'],
  ]) assert.ok(render(source).includes(`\x1b[1m${bold}\x1b[22m`), source);
});

test('compatibility preserves valid emphasis, code and escaped literal asterisks', () => {
  for (const source of [
    '**重点**后续文字', '**重点**：后续文字', '**重点：** 后续文字',
    '***重点***后续文字', '**重点 **后续文字', '**尚未结束：*',
    '`**重点：**文字`', '``包含 ` 和 **重点：**文字``',
    '```markdown\n**重点：**文字\n```',
    '~~~~markdown\n**重点：**文字\n~~~\n**仍在代码：**文字\n~~~~',
    '```markdown\n**未闭合代码：**文字',
    '    **缩进代码：**文字', '\t**缩进代码：**文字',
    '> ```markdown\n> **引用内代码：**文字\n> ```',
    '- ```markdown\n  **列表内代码：**文字\n  ```',
    '\\*\\*重点：\\*\\*文字', '\\**重点：**文字', '**字面星号\\**文字',
    '`跨行代码\n**重点：**文字`',
    '$x^2 + y^2$，\\(a_b\\)，$$E=mc^2$$',
  ]) assert.equal(assistantMarkdownCompatibility(source, context), source, source);
});

test('only assistant display text changes, including complete pairs during streaming', () => {
  const source = '`**示例：**文字`，**温度：**800 °C\n```\n**代码：**文字\n```\n**时长：**2 h';
  const output = assistantMarkdownCompatibility(source, context);
  assert.ok(output.includes('`**示例：**文字`'));
  assert.ok(output.includes('**温度：** 800 °C'));
  assert.ok(output.includes('```\n**代码：**文字\n```'));
  assert.ok(output.includes('**时长：** 2 h'));
  assert.equal(assistantMarkdownCompatibility(output, context), output);
  for (const messageType of ['user', 'assistant-thinking']) {
    assert.equal(assistantMarkdownCompatibility(source, { ...context, messageType }), source);
  }
  for (const partial of ['**温度：', '**温度：*', '**温度：**']) {
    assert.equal(assistantMarkdownCompatibility(partial, { ...context, isStreaming: true }), partial);
  }
  assert.equal(assistantMarkdownCompatibility('**温度：**800', { ...context, isStreaming: true }), '**温度：** 800');
  assert.equal(assistantMarkdownCompatibility('```\n**代码：**文字\n```\n**温度：**800', context), '```\n**代码：**文字\n```\n**温度：** 800');
});

test('Pi loads the SpinA extension and renders assistant messages without mutating their source', async () => {
  const { loadExtensions } = await import(new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/spina.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const transformer = loaded.extensions[0].markdownTransformer;
  assert.equal(typeof transformer, 'function');
  const message = { role: 'assistant', content: [{ type: 'text', text: '**制备方法：**溶胶凝胶法' }] };
  const original = structuredClone(message);
  const component = new AssistantMessageComponent(message, false, theme, 'Thinking...', 0, [transformer]);
  for (const isStreaming of [true, false]) {
    component.updateContent(message, isStreaming);
    const output = component.render(100).join('\n');
    assert.ok(output.includes('\x1b[1m制备方法：\x1b[22m'));
    assert.ok(!output.includes('**'));
  }
  assert.deepEqual(message, original);
});
