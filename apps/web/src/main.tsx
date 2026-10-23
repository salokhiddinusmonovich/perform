import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { i18nReady } from './i18n';
import './index.css';
import { Providers } from './app/providers';
import { router } from './app/router';

// Render once the active language is loaded, so no raw translation keys flash on screen.
// If it failed to load, still render: a page with keys beats a blank one.
i18nReady
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Providers>
          <RouterProvider router={router} />
        </Providers>
      </StrictMode>,
    );
  });
