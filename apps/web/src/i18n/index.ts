import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ru from './ru.json';
import tr from './tr.json';
import uz from './uz.json';

export const LANGUAGES = { uz: "O'zbekcha", ru: 'Русский', tr: 'Türkçe', en: 'English' } as const;
export type Language = keyof typeof LANGUAGES;

const saved = (() => {
  try {
    return localStorage.getItem('lang');
  } catch {
    return null;
  }
})();

i18n.use(initReactI18next).init({
  resources: { uz: { t: uz }, ru: { t: ru }, tr: { t: tr }, en: { t: en } },
  defaultNS: 't',
  lng: saved && saved in LANGUAGES ? saved : 'uz',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: Language) {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // storage unavailable; language still changes for this session
  }
}

export default i18n;
