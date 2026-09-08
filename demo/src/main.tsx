import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Global, css } from '@emotion/react';
import { fonts } from '@workday/canvas-kit-react/fonts';

import './index.css';

// Canvas Kit's base design-token CSS variables (colors, spacing, etc.) --
// components fall back to reasonable defaults without this, but importing
// it gets the real Canvas color palette instead of the fallback values
// baked into each component's styles.
import '@workday/canvas-tokens-web/css/base/_variables.css';
import '@workday/canvas-tokens-web/css/brand/_variables.css';
import '@workday/canvas-tokens-web/css/system/_variables.css';
// Overrides some of the variables above with Sana Canvas's palette --
// required alongside the `data-theme="sana-canvas"` attribute on <html>
// (index.html) for the Sana theme to actually take visual effect.
import '@workday/canvas-tokens-web/css/sana/_variables.css';

import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Injects Canvas's @font-face declarations globally -- see
        https://www.npmjs.com/package/@workday/canvas-kit-react/fonts.
        Without this, text renders in the browser's default font instead
        of Canvas's actual typeface. */}
    <Global styles={css(fonts)} />
    <App />
  </StrictMode>,
);
