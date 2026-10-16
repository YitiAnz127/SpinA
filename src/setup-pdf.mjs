import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = resolve(root, '.runtime/pdf-tools.json');
await mkdir(resolve(root, '.runtime'), { recursive: true });
let config = {};
try { config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const candidates = [process.env.SPINA_PDF_PYTHON, config.python, 'python', 'python3'].filter(Boolean);
let python;
for (const candidate of candidates) {
  try {
    const result = await exec(candidate, ['-c', 'import sys; print(sys.executable)'], { windowsHide: true });
    python = result.stdout.trim(); break;
  } catch { /* Try the next configured interpreter. */ }
}
if (!python) throw Error('找不到 Python；请安装 Python 或设置 SPINA_PDF_PYTHON');
try { await exec(python, ['-c', 'import pdfplumber,pypdf,pypdfium2'], { windowsHide: true }); }
catch {
  await exec(python, ['-m', 'venv', resolve(root, '.runtime/pdf-python')], { windowsHide: true });
  python = resolve(root, process.platform === 'win32' ? '.runtime/pdf-python/Scripts/python.exe' : '.runtime/pdf-python/bin/python');
  await exec(python, ['-m', 'pip', 'install', '-r', resolve(root, 'requirements-pdf.txt')], { windowsHide: true });
}

const langPath = resolve(root, '.runtime/tessdata');
await mkdir(langPath, { recursive: true });
// Use sync realpath consistently with the Windows project source reader.
const { realpathSync } = await import('node:fs');
const rel = relative(realpathSync(root), realpathSync(langPath));
if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw Error('OCR 识别模型必须保存到项目内');
for (const language of ['eng', 'chi_sim']) {
  const path = resolve(langPath, `${language}.traineddata`);
  try { await access(path); continue; } catch { /* Download missing language data. */ }
  const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${language}.traineddata`);
  if (!response.ok) throw Error(`下载 ${language} OCR 模型失败：${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
config = { ...config, python, ocr_lang_path: '.runtime/tessdata', ocr_languages: config.ocr_languages ?? 'eng+chi_sim' };
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
console.log('PDF 文字、布局、表格及英文／简体中文 OCR 已配置。');
