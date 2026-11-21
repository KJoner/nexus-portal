import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Popup } from './ui/Popup';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Popup />
    </ErrorBoundary>
  </StrictMode>,
);
