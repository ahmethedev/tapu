import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectFs, splitRelative } from '../src/fsafe.js';
import { tempRoot } from './helpers.js';

describe('project filesystem', () => {
  it('rejects absolute paths and . / .. segments', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a/.', '']) {
      expect(() => splitRelative(bad), bad).toThrow(/unsafe|Refusing/);
    }
    expect(splitRelative('db-wiki/tables/public.orders.md')).toEqual(['db-wiki', 'tables', 'public.orders.md']);
  });

  it('writes atomically, creates directories and skips unchanged content', async () => {
    const fs = await ProjectFs.open(await tempRoot());
    expect(await fs.write('a/b/c.txt', 'one')).toBe(true);
    expect(await fs.write('a/b/c.txt', 'one')).toBe(false);
    expect(await fs.write('a/b/c.txt', 'two')).toBe(true);
    expect(await fs.read('a/b/c.txt')).toBe('two');
    expect(await readdir(join(fs.root, 'a/b'))).toEqual(['c.txt']); // no temporary files left behind
    expect(await fs.read('a/missing.txt')).toBeNull();
    expect(await fs.list('missing')).toBeNull();
  });

  it('refuses to read or write through symbolic links', async () => {
    const outside = await tempRoot();
    await writeFile(join(outside, 'secret.txt'), 'outside');
    const root = await tempRoot();
    await symlink(outside, join(root, 'db-wiki'));
    await mkdir(join(root, '.tapu'));
    await symlink(join(outside, 'secret.txt'), join(root, '.tapu', 'catalog.json'));
    const fs = await ProjectFs.open(root);

    await expect(fs.read('db-wiki/index.md')).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(fs.write('db-wiki/index.md', 'x')).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(fs.list('db-wiki')).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(fs.read('.tapu/catalog.json')).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(fs.write('.tapu/catalog.json', 'x')).rejects.toMatchObject({ code: 'unsafe_path' });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('accepts a project directory that is itself reached through a link', async () => {
    const real = await tempRoot();
    const linkParent = await tempRoot();
    await symlink(real, join(linkParent, 'project'));
    const fs = await ProjectFs.open(join(linkParent, 'project'));
    await fs.write('x.txt', 'ok');
    expect(await readFile(join(real, 'x.txt'), 'utf8')).toBe('ok');
  });

  it('fails clearly for a missing project directory', async () => {
    await expect(ProjectFs.open('/nonexistent/tapu-project')).rejects.toMatchObject({ code: 'invalid_project_dir' });
  });
});
