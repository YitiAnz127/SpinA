import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export interface SourceVersion { path: string; size: number; mtime_ms: number; sha256: string }

/** Bind cached outputs and page images to the actual source bytes, not only file metadata. */
export async function sourceVersion(root: string, path: string): Promise<SourceVersion> {
  const actualRoot = realpathSync(root), actualPath = realpathSync(resolve(root, path));
  const rel = relative(actualRoot, actualPath);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('来源必须位于项目内');
  const info = await stat(actualPath), hash = createHash('sha256');
  for await (const bytes of createReadStream(actualPath)) hash.update(bytes);
  const after = await stat(actualPath);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('读取期间来源已改变，请重试');
  return { path: rel.split(sep).join('/'), size: info.size, mtime_ms: info.mtimeMs, sha256: hash.digest('hex') };
}

export function sourcePageDirectory(root: string, version: SourceVersion): string {
  const path = process.platform === 'win32' ? version.path.toLowerCase() : version.path;
  const key = createHash('sha256').update(path).update('\0').update(version.sha256).digest('hex');
  return resolve(root, 'data/distillation/pages', basename(version.path, '.pdf'), key);
}
