#!/usr/bin/env node
/**
 * Postinstall script to inject custom CSS into ElizaOS client
 * This runs automatically after npm install
 */

const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(
  __dirname,
  '../node_modules/@elizaos/server/dist/client/index.html'
);

const customCSS = `
    <style>
      /* Hide list bullets in left menu */
      ul, ol, li {
        list-style: none !important;
        list-style-type: none !important;
      }
      li::marker {
        content: none !important;
        display: none !important;
      }
      aside ul, aside li, nav ul, nav li,
      [class*="sidebar"] ul, [class*="sidebar"] li,
      [class*="menu"] ul, [class*="menu"] li {
        list-style: none !important;
        list-style-type: none !important;
        padding-left: 0 !important;
        margin-left: 0 !important;
      }
      li::before {
        content: none !important;
        display: none !important;
      }
    </style>`;

try {
  if (!fs.existsSync(indexHtmlPath)) {
    console.log('[postinstall] ElizaOS client index.html not found, skipping CSS injection');
    process.exit(0);
  }

  let html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Check if CSS is already injected
  if (html.includes('/* Hide list bullets in left menu */')) {
    console.log('[postinstall] Custom CSS already injected, skipping');
    process.exit(0);
  }

  // Inject CSS before </head>
  html = html.replace('</head>', `${customCSS}\n  </head>`);

  fs.writeFileSync(indexHtmlPath, html, 'utf8');
  console.log('[postinstall] Custom CSS injected into ElizaOS client');
} catch (error) {
  console.error('[postinstall] Error injecting CSS:', error.message);
  // Don't fail the install
  process.exit(0);
}
