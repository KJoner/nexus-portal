import '@fontsource/manrope/300.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

// Production only: the Service Worker serves the app shell offline (C3-4). Registration waits until
// after load so precaching (~1.5 MB, dozens of requests) never competes with the first paint, the
// config fetch or the live connection on HTTP/1.1. Dev keeps HMR clean.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const register = () => void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
  const later = () => setTimeout(register, 3000);
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
