import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import ru from './ru.json';
import tr from './tr.json';
import uz from './uz.json';

type Tree = { [key: string]: string | Tree };

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : keys(v, `${prefix}${k}.`),
  );
}

function placeholders(tree: Tree, prefix = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === 'string') out[prefix + k] = (v.match(/{{\w+}}/g) ?? []).sort();
    else Object.assign(out, placeholders(v, `${prefix}${k}.`));
  }
  return out;
}

const languages = { uz, ru, tr } as Record<string, Tree>;

const REPO = resolve(__dirname, '../../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (dir: string) => sourceFiles(join(REPO, dir)).map((f) => readFileSync(f, 'utf8')).join('\n');
const matches = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);
const enKeys = new Set(keys(en as Tree));

describe('keys used in code exist in the translations', () => {
  it('web: every literal t("…") key', () => {
    const used = matches(read('apps/web/src'), /\bt\(\s*'([a-zA-Z0-9_.]+)'/g);
    expect(used.length).toBeGreaterThan(50);
    expect(used.filter((k) => !enKeys.has(k))).toEqual([]);
  });

  it('shared schemas and API: every validation message', () => {
    const used = matches(read('packages/schemas/src') + read('apps/api/src'), /'(validation\.[a-zA-Z]+)'/g);
    expect(used.filter((k) => !enKeys.has(k))).toEqual([]);
  });

  it('API: every error code (shown as errors.<code>)', () => {
    const api = read('apps/api/src');
    const codes = [
      ...matches(api, /\b(?:badRequest|unauthorized|forbidden|notFound|conflict|tooManyRequests)\(\s*'([a-zA-Z.]+)'/g),
      // Defaults of the helpers in api-error.ts
      'auth.required',
      'auth.forbidden',
      'notFound',
    ].filter((c) => c !== 'validation');
    expect(codes.filter((c) => !enKeys.has(`errors.${c}`))).toEqual([]);
  });
});

describe('translations', () => {
  for (const [lang, tree] of Object.entries(languages)) {
    it(`${lang} has exactly the same keys as en`, () => {
      expect(keys(tree).sort()).toEqual(keys(en).sort());
    });

    it(`${lang} uses the same {{placeholders}} as en`, () => {
      expect(placeholders(tree)).toEqual(placeholders(en));
    });
  }
});
