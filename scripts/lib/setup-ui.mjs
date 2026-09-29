// Genera la UI autocontenida del instalador (installer/build/gen/setup-ui.html) a partir de
// installer/ui/{index.html,setup.css,setup.js}, los tokens VØXORA de app/ui/tokens, las fuentes
// latinas de app/ui/fonts (data: URI) y el logo/isotipo de app/ui/assets (SVG en línea).
// VoxoraMeetSetup.exe la incrusta como recurso SETUP_UI y la carga con NavigateToString (≤ 2 MB).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './version.mjs';

const UI = path.join(ROOT, 'app', 'ui');
const TOKENS = ['colors.css', 'effects.css', 'spacing.css', 'typography.css'];
const FONTS = [
  { family: 'Inter', file: 'inter-latin.woff2', weight: '300 700' },
  { family: 'Space Grotesk', file: 'space-grotesk-latin.woff2', weight: '300 700' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono-latin.woff2', weight: '400 500' },
];
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

function inlineSvg(file, { className } = {}) {
  let svg = readFileSync(file, 'utf8');
  svg = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[\s\S]*?<\/title>/g, '').replace(/\s*\n\s*/g, ' ').trim();
  if (className) svg = svg.replace('<svg ', `<svg class="${className}" aria-hidden="true" `);
  return svg;
}

export function buildSetupUi({ root = ROOT, out = path.join(root, 'installer', 'build', 'gen', 'setup-ui.html') } = {}) {
  const src = path.join(root, 'installer', 'ui');
  let html = readFileSync(path.join(src, 'index.html'), 'utf8');
  const tokens = TOKENS.map((t) => readFileSync(path.join(UI, 'tokens', t), 'utf8')).join('\n');
  const fonts = FONTS.map(({ family, file, weight }) => {
    const data = readFileSync(path.join(UI, 'fonts', file)).toString('base64');
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${LATIN};}`;
  }).join('\n');
  const css = readFileSync(path.join(src, 'setup.css'), 'utf8');
  const js = readFileSync(path.join(src, 'setup.js'), 'utf8');
  // indexOf/slice (no String.replace): el contenido trae `$` que replace interpretaría.
  const put = (marker, value) => {
    const i = html.indexOf(marker);
    if (i < 0) throw new Error(`Falta el marcador ${marker} en installer/ui/index.html`);
    html = html.slice(0, i) + value + html.slice(i + marker.length);
  };
  put('/*@TOKENS@*/', tokens);
  put('/*@FONTS@*/', fonts);
  put('/*@CSS@*/', css);
  put('/*@JS@*/', js);
  put('<!--@ISOTIPO@-->', inlineSvg(path.join(UI, 'assets', 'isotipo.svg')));
  put('<!--@LOGO@-->', inlineSvg(path.join(UI, 'assets', 'logo.svg')));
  const bytes = Buffer.byteLength(html);
  if (bytes > 1.8 * 1024 * 1024) throw new Error(`La UI del instalador pesa ${bytes} bytes (NavigateToString admite 2 MB)`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { file: out, bytes };
}
