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
