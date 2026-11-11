import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/theme.css';
import App from './App';
import { UiLocaleProvider } from '@/ui/i18n';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <UiLocaleProvider><App /></UiLocaleProvider>
    </React.StrictMode>,
  );
}
