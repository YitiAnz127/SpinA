import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'tests']) {
  for (const file of await readdir(resolve(root, directory), { recursive: true })) {
    if (!/\.mjs$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', resolve(root, directory, file)], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
