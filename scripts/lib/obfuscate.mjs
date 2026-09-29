// Empaquetado y ofuscación del código JS que viaja en el instalador.
//   - Motor: esbuild agrupa app/engine/engine.mjs y los módulos hermanos (capture, pipeline,
//     sync-buffer, billing, windows-driver) en un solo engine.mjs ESM; luego javascript-obfuscator.
//   - UI: cada módulo ES de app/ui se transforma y ofusca por separado (mismos nombres de archivo e
//     import/export intactos: el grafo de módulos no cambia).
// Opciones de ofuscación: las de 03 Plugin OBS/scripts/obfuscate-build.mjs (sin control-flow
// flattening ni dead code, stringArray base64 al 65 %, sin renombrar propiedades).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build, transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { ROOT } from './version.mjs';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function seedFor(key) {
  const value = Number.parseInt(sha256(key).slice(0, 8), 16);
  return value === 0 ? 360 : value;
}

/** Opciones comunes (idénticas en espíritu a las del Plugin OBS). */
export function obfuscatorOptions(key, { target = 'node', renameGlobals = false } = {}) {
  return {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    identifiersPrefix: `_vx_${sha256(key).slice(0, 8)}_`,
    ignoreImports: true,
    log: false,
    numbersToExpressions: false,
    renameGlobals,
    renameProperties: false,
    seed: seedFor(key),
    selfDefending: false,
    simplify: true,
    sourceMap: false,
    splitStrings: false,
    stringArray: true,
    stringArrayCallsTransform: false,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.65,
    target,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  };
}

export function obfuscate(code, key, options) {
  const out = `${JavaScriptObfuscator.obfuscate(code, obfuscatorOptions(key, options)).getObfuscatedCode()}\n`;
  if (sha256(out) === sha256(code)) throw new Error(`La ofuscación no modificó ${key}`);
  return out;
}

/**
 * Motor en un solo archivo. Se usa un punto de entrada sin exports para poder renombrar también los
 * identificadores de nivel superior (clases y funciones del bundle).
 */
export async function bundleEngine() {
  const entry = path.join(ROOT, 'app', 'engine', 'engine.mjs');
  const result = await build({
    stdin: {
      contents: `import ${JSON.stringify(entry.replace(/\\/g, '/'))};\n`,
      resolveDir: ROOT,
      sourcefile: 'engine-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    write: false,
    logLevel: 'silent',
    metafile: true,
  });
  const code = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs).filter((f) => !f.startsWith('<stdin>')).sort();
  const obfuscated = obfuscate(code, 'engine/engine.mjs', { target: 'node', renameGlobals: true });
  return { code: obfuscated, bundledBytes: Buffer.byteLength(code), inputs };
}

/** Un módulo ES de la UI: transformación (sin cambiar import/export) + ofuscación. */
export async function obfuscateUiModule(source, relPath) {
  const transformed = await transform(source, {
    charset: 'utf8',
    format: 'esm',
    legalComments: 'none',
    loader: 'js',
    minify: false,
    sourcefile: relPath,
    sourcemap: false,
    target: 'es2022',
  });
  return obfuscate(transformed.code, `ui/${relPath}`, { target: 'browser', renameGlobals: false });
}
