import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';

export const LANGUAGES = { uz: 'Oʻzbekcha', ru: 'Русский', tr: 'Türkçe', en: 'English' } as const;
export type Language = keyof typeof LANGUAGES;

const STORAGE_KEY = 'lang';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && value in LANGUAGES;
}

function savedLanguage(): Language | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

// Each language is its own chunk, so a visitor downloads only the language they use.
const translations: Record<Language, () => Promise<{ default: object }>> = {
  uz: () => import('./uz.json'),
  ru: () => import('./ru.json'),
  tr: () => import('./tr.json'),
  en: () => import('./en.json'),
};

const lazyTranslations: BackendModule = {
  type: 'backend',
  init() {},
  read(lng, _ns, callback) {
    if (!isLanguage(lng)) return callback(new Error(`Unknown language: ${lng}`), false);
    translations[lng]().then(
      (module) => callback(null, module.default),
      (error: Error) => callback(error, false),
    );
  },
};

const syncHtmlLang = (lang: string) => document.documentElement.setAttribute('lang', lang);
i18n.on('languageChanged', syncHtmlLang);

/** Resolves once the active language is loaded. Render the app only after it. */
export const i18nReady = i18n
  .use(lazyTranslations)
  .use(initReactI18next)
  .init({
    defaultNS: 't',
    ns: ['t'],
    lng: savedLanguage() ?? 'uz',
    // No fallback language: i18n.test.ts guarantees every language has every key, and a
    // fallback would make every visitor download a second language.
    fallbackLng: false,
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });

/**
 * Loads the language, then switches to it, so the page never shows raw keys.
 * Rejects (and keeps the current language) when the language can't be loaded.
 */
export async function setLanguage(lang: Language) {
  await i18n.loadLanguages(lang);
  if (!i18n.hasResourceBundle(lang, 't')) throw new Error(`Language not loaded: ${lang}`);
  await i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Storage unavailable: the language still changes for this session.
  }
}

export default i18n;
