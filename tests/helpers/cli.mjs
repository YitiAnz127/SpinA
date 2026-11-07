import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const exec = promisify(execFile);
export const root = fileURLToPath(new URL('../../', import.meta.url));

/** Run a project CLI entry point and capture its exit code without throwing. */
export async function run(script, args = [], options = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', resolve(root, script), ...args], {
      cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error };
  }
}

export async function runJson(script, args = [], options = {}) {
  const result = await run(script, args, options);
  if (result.code !== 0) throw new Error(`${script} ${args.join(' ')} 退出码 ${result.code}：${result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${script} 未输出有效 JSON：${result.stdout.slice(0, 400)}`); }
}
