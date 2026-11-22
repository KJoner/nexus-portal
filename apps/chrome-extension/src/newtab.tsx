import '@fontsource/manrope/300.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import './styles.css';
import { preloadPinyin } from '@web/lib/pinyin';
import { applyRememberedTheme } from '@web/lib/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';
import { sync } from './lib/sync';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { NewTab } from './ui/NewTab';

// Local first: this extension's collection (or the account's cached navigation) renders before any
// network request is made.
applyRememberedTheme();
const { space } = await boot();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <NewTab space={space} />
    </ErrorBoundary>
  </StrictMode>,
);
preloadPinyin();

// The account's navigation: revalidate in the background (throttled, one tab at a time), and again
// whenever this tab comes back into view or the network returns. A local collection asks no server.
if (space === 'account') {
  void sync();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sync();
  });
  window.addEventListener('online', () => void sync({ force: true }));
}
