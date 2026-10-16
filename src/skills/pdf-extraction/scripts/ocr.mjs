import { readFile } from 'node:fs/promises';
import { createWorker } from 'tesseract.js';

const [langPath, languages, input] = process.argv.slice(2);
let worker;
let timer;
function fail(error) {
  console.error(`OCR 失败：${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
function deadline() {
  clearTimeout(timer);
  timer = setTimeout(() => fail('单页识别超过 120 秒'), 120000);
}
try {
  const pages = JSON.parse(await readFile(input, 'utf8'));
  deadline();
  worker = await createWorker(languages.split('+'), 1, { langPath, gzip: false, cacheMethod: 'none', errorHandler: fail });
  const results = [];
  for (const page of pages) {
    deadline();
    const result = await worker.recognize(page.path);
    results.push({ number: page.number, text: result.data.text.trim() });
  }
  console.log(JSON.stringify(results));
} catch (error) {
  fail(error);
} finally {
  clearTimeout(timer);
  await worker?.terminate();
}
