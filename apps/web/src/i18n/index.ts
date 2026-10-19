import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ru from './ru.json';
import tr from './tr.json';
import uz from './uz.json';

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

i18n.use(initReactI18next).init({
  resources: { uz: { t: uz }, ru: { t: ru }, tr: { t: tr }, en: { t: en } },
  defaultNS: 't',
  lng: savedLanguage() ?? 'uz',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  showSupportNotice: false,
});

const syncHtmlLang = (lang: string) => document.documentElement.setAttribute('lang', lang);
syncHtmlLang(i18n.language);
i18n.on('languageChanged', syncHtmlLang);

export function setLanguage(lang: Language) {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Storage unavailable: the language still changes for this session.
  }
}

export default i18n;
