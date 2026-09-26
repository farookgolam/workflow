import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { GlobalApp } from './App';
import { GlobalAuthProvider } from './auth';
import '@fontsource-variable/outfit';
import '../styles.css';
import { applyTheme, storedTheme } from '../theme';

applyTheme(storedTheme());

document.body.classList.add('global'); // the console's navy frame (styles.css)

// Served at /global on any host (and, if one is configured, on the management host itself).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/global">
      <GlobalAuthProvider>
        <GlobalApp />
      </GlobalAuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
