import '@fontsource/manrope/300.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import './styles.css';
import { preloadPinyin } from '@web/lib/pinyin';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';
import { sync } from './lib/sync';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { NewTab } from './ui/NewTab';

// Local first: the cached navigation renders before any network request is made.
await boot();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <NewTab />
    </ErrorBoundary>
  </StrictMode>,
);

// Then revalidate in the background (throttled, one tab at a time), and again whenever this tab
// comes back into view or the network returns.
void sync();
preloadPinyin();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void sync();
});
window.addEventListener('online', () => void sync({ force: true }));
