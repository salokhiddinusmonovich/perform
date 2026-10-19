import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type Language } from './i18n';

type Health = { status: 'ok'; db: 'up' } | { status: 'error' } | null;

export default function App() {
  const { t, i18n } = useTranslation();
  const [health, setHealth] = useState<Health>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : { status: 'error' }))
      .then(setHealth)
      .catch(() => setHealth({ status: 'error' }));
  }, []);

  const label = health === null ? t('checking') : health.status === 'ok' ? t('ok') : t('down');

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>{t('appName')}</h1>
          <p className="muted">{t('tagline')}</p>
        </div>
        <select
          value={i18n.language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          aria-label="Language"
        >
          {Object.entries(LANGUAGES).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </header>

      <section className="card">
        <h2>{t('serverStatus')}</h2>
        <p>
          <span className={`dot ${health?.status ?? 'pending'}`} /> API · {t('database')}: {label}
        </p>
      </section>
    </main>
  );
}
