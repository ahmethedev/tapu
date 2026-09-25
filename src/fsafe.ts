import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TapuError } from './errors.js';

// All reads and writes of Tapu-managed artifacts go through ProjectFs. Paths
// are relative to the project directory; `.`/`..` segments are rejected and no
// existing component may be a symbolic link, so managed reads and writes never
// leave the project. Each file is replaced atomically (temporary file +
// rename); a multi-file refresh is not atomic as a whole.

/** Splits a relative `/`-separated path; throws on absolute paths and `.`/`..`/empty segments. */
export function splitRelative(rel: string): string[] {
  const parts = rel.split('/');
  if (rel.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0'))) {
    throw new TapuError('unsafe_path', `Refusing path "${rel}": it must be relative and stay inside the project.`);
  }
  return parts;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function unsafe(rel: string, reason: string): TapuError {
  return new TapuError('unsafe_path', `Refusing to use ${rel}: ${reason}.`, { path: rel });
}

export class ProjectFs {
  private constructor(readonly root: string) {}

  static async open(dir: string): Promise<ProjectFs> {
    let root: string;
    try {
      root = await realpath(dir);
    } catch {
      throw new TapuError('invalid_project_dir', `Project directory not found: ${dir}`);
    }
    if (!(await lstat(root)).isDirectory()) {
      throw new TapuError('invalid_project_dir', `Project directory is not a directory: ${dir}`);
    }
    return new ProjectFs(root);
  }

  /** Absolute path for `rel`, after checking every existing component. */
  async resolve(rel: string): Promise<string> {
    const parts = splitRelative(rel);
    let path = this.root;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]!);
      const st = await lstatOrNull(path);
      if (!st) return join(this.root, ...parts);
      const shown = parts.slice(0, i + 1).join('/');
      if (st.isSymbolicLink()) throw unsafe(rel, `${shown} is a symbolic link`);
      if (i < parts.length - 1 && !st.isDirectory()) throw unsafe(rel, `${shown} is not a directory`);
    }
    return path;
  }

  /** File contents, or null when the file does not exist. */
  async read(rel: string): Promise<string | null> {
    const path = await this.resolve(rel);
    const st = await lstatOrNull(path);
    if (!st) return null;
    if (!st.isFile()) throw unsafe(rel, 'it is not a regular file');
    return readFile(path, 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    return (await lstatOrNull(await this.resolve(rel))) !== null;
  }

  /** Entry names of a directory, or null when it does not exist. */
  async list(rel: string): Promise<string[] | null> {
    const path = await this.resolve(rel);
    const st = await lstatOrNull(path);
    if (!st) return null;
    if (!st.isDirectory()) throw unsafe(rel, 'it is not a directory');
    return (await readdir(path)).sort();
  }

  async mkdirs(rel: string): Promise<void> {
    const parts = splitRelative(rel);
    let path = this.root;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]!);
      let st = await lstatOrNull(path);
      if (!st) {
        try {
          await mkdir(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        st = await lstat(path);
      }
      const shown = parts.slice(0, i + 1).join('/');
      if (st.isSymbolicLink()) throw unsafe(rel, `${shown} is a symbolic link`);
      if (!st.isDirectory()) throw unsafe(rel, `${shown} is not a directory`);
    }
  }

  /** Atomically replaces `rel` unless it already has exactly this content. Returns whether it wrote. */
  async write(rel: string, content: string): Promise<boolean> {
    if ((await this.read(rel)) === content) return false;
    const parts = splitRelative(rel);
    if (parts.length > 1) await this.mkdirs(parts.slice(0, -1).join('/'));
    const path = await this.resolve(rel);
    const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o644);
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return true;
  }
}
