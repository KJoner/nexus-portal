import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { applyRememberedTheme } from '@web/lib/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';
import { sync } from './lib/sync';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Options } from './ui/Options';

await boot();
// The theme this extension's new tab last showed (深色 / 浅色 / 跟随系统), from the first paint.
applyRememberedTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Options />
    </ErrorBoundary>
  </StrictMode>,
);
void sync();
