/**
 * Monta la interfaz del programa a partir del repositorio del overlay.
 * Genera DOS cosas desde el MISMO origen:
 *
 *   app/renderer/          lo que carga la ventana del observador (el panel)
 *                          y la página del jugador;
 *   overlay-empaquetado/   el overlay completo que sirve el servidor local
 *                          (5310) y que el builder empaqueta como recurso
 *                          `overlay`. Antes se mantenía a mano y se quedaba
 *                          desfasado; ahora se regenera en cada build.
 *
 * Origen: `../overlay` (carpeta hermana) o la ruta de `EASY_OVERLAY`
 * (relativa a este proyecto). Cada destino se borra y se rehace entero.
 *
 * Verificación de referencias (falla el build, salida 1): importaciones
 * estáticas `from '…'`, importaciones sin `from` (`import '…'`), `import('…')`
 * dinámicos con literal, `export … from '…'`, `url(…)` y `@import` de CSS, y
 * `src`/`href` de HTML (también los módulos en línea de los HTML). Se ignoran
 * las que empiezan por `http:`, `https:`, `data:`, `blob:`, `#` o `/`.
 *
 * Uso: node scripts/monta-overlay.mjs [--version <x.y.z>]
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROYECTO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── Referencias ──────────────────────────────────────────────────────────── */

const IGNORADAS = /^(https?:|data:|blob:|mailto:|about:|#|\/)/i;

/** Especificadores de módulo dentro de un texto JS. */
export function referenciasJs(texto) {
  const refs = [];
  const patrones = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import … from '…' y export … from '…'
    /\bimport\s*['"]([^'"]+)['"]/g, // import '…'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('…')
  ];
  // Fuera comentarios (una aproximación suficiente para código propio).
  const limpio = texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  for (const p of patrones) for (const m of limpio.matchAll(p)) refs.push(m[1]);
  return refs;
}

export function referenciasCss(texto) {
  const limpio = texto.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [];
  for (const m of limpio.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) refs.push(m[2].trim());
  for (const m of limpio.matchAll(/@import\s+['"]([^'"]+)['"]/g)) refs.push(m[1]);
  return refs;
}

export function referenciasHtml(texto) {
  const sinComentarios = texto.replace(/<!--[\s\S]*?-->/g, '');
  const refs = [];
  for (const m of sinComentarios.matchAll(/\s(?:src|href)\s*=\s*(['"])([^'"]*)\1/gi)) refs.push(m[2]);
  // Módulos en línea: <script type="module"> … </script>
  for (const m of sinComentarios.matchAll(/<script\b[^>]*type\s*=\s*['"]module['"][^>]*>([\s\S]*?)<\/script>/gi)) {
    refs.push(...referenciasJs(m[1]));
  }
  return refs;
}

function ficheros(dir) {
  const salida = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) salida.push(...ficheros(ruta));
    else salida.push(ruta);
  }
  return salida;
}

/** Referencias rotas dentro de `raiz`: lista de `fichero → referencia`. */
export function verificaReferencias(raiz) {
  const rotas = [];
  for (const f of ficheros(raiz)) {
    const ext = extname(f).toLowerCase();
    let refs;
    if (ext === '.js' || ext === '.mjs') refs = referenciasJs(readFileSync(f, 'utf8'));
    else if (ext === '.css') refs = referenciasCss(readFileSync(f, 'utf8'));
    else if (ext === '.html') refs = referenciasHtml(readFileSync(f, 'utf8'));
    else continue;
    for (const ref of refs) {
      if (ref === '' || IGNORADAS.test(ref) || ref.includes('${')) continue;
      const limpia = ref.split('?')[0].split('#')[0];
      if (limpia === '') continue;
      // Un especificador sin ruta relativa ("socket.io-client") no lo resuelve el navegador.
      const esRelativa = limpia.startsWith('./') || limpia.startsWith('../') || ext === '.css' || ext === '.html';
      const destino = resolve(dirname(f), decodeURIComponent(limpia));
      const dentro = destino === resolve(raiz) || destino.startsWith(resolve(raiz) + sep);
      if (!esRelativa || !dentro || !existsSync(destino) || !statSync(destino).isFile()) {
        rotas.push(`${relative(raiz, f)} → ${ref}`);
      }
    }
  }
  return rotas;
}

/* ── Montaje ──────────────────────────────────────────────────────────────── */

/** Lo que NO va al overlay empaquetado: herramientas, documentación, dependencias, pruebas. */
function copiable(origen, ruta) {
  const rel = relative(origen, ruta);
  if (rel === '') return true;
  const partes = rel.split(sep);
  const nombre = partes[partes.length - 1];
  if (partes.some((p) => p.startsWith('.'))) return false; // .git, .claude, .claude-flow, .gitignore…
  if (partes.includes('node_modules')) return false;
  if (partes[0] === 'tools') return false;
  if (partes[0] === 'combate-wasm' && ['banco', 'assembly'].includes(partes[1])) return false;
  if (/\.(md|test\.mjs|test\.js|d\.ts|log)$/i.test(nombre)) return false;
  if (partes.length === 1 && ['package.json', 'package-lock.json', 'tsconfig.json', 'asconfig.json'].includes(nombre)) return false;
  if (partes[0] === 'combate-wasm' && ['package.json', 'package-lock.json', 'asconfig.json'].includes(nombre)) return false;
  return true;
}

function falla(mensaje) {
  console.error(`✗ ${mensaje}`);
  process.exit(1);
}

export function montaTodo({ version, origen, salida = join(PROYECTO, 'app'), empaquetado = join(PROYECTO, 'overlay-empaquetado') }) {
  if (!existsSync(origen) || !statSync(origen).isDirectory()) {
    falla(
      `no encuentro el overlay en ${origen}.\n` +
        '  Clónalo como carpeta hermana (../overlay) o indica la ruta con EASY_OVERLAY=<ruta> (relativa a este proyecto).',
    );
  }

  /* 1. El renderer: piezas obligatorias, espejando la raíz del overlay. */
  const renderer = join(salida, 'renderer');
  rmSync(renderer, { recursive: true, force: true });
  const piezas = [
    ['panel', 'panel'],
    [join('comun', 'vendor'), join('comun', 'vendor')],
    ['fonts', 'fonts'],
    ['fonts.css', 'fonts.css'],
  ];
  for (const [de, a] of piezas) {
    const ruta = join(origen, de);
    if (!existsSync(ruta)) falla(`falta ${de} en el overlay (${origen})`);
    cpSync(ruta, join(renderer, a), { recursive: true });
  }
  const jugador = join(PROYECTO, 'recursos', 'jugador.html');
  if (!existsSync(jugador)) falla('falta recursos/jugador.html');
  cpSync(jugador, join(renderer, 'jugador.html'));
  rmSync(join(renderer, 'panel', 'README.md'), { force: true });

  const ahora = new Date().toISOString();
  const sello = `${version}+${ahora.slice(0, 10)} ${ahora.slice(11, 16)}`;
  const indice = join(renderer, 'panel', 'index.html');
  const html = readFileSync(indice, 'utf8');
  if (!html.includes('</head>')) falla('panel/index.html no tiene </head>');
  writeFileSync(indice, html.replace('</head>', `  <meta name="easy-version" content="${sello}" />\n</head>`));

  const rotasRenderer = verificaReferencias(renderer);
  if (rotasRenderer.length > 0) {
    falla(`referencias rotas en el renderer:\n${rotasRenderer.map((r) => `  · ${r}`).join('\n')}`);
  }
  console.log(`renderer montado en app/renderer (versión ${sello})`);

  /* 2. El overlay completo para el servidor local. */
  rmSync(empaquetado, { recursive: true, force: true });
  cpSync(origen, empaquetado, { recursive: true, filter: (ruta) => copiable(origen, ruta) });
  const rotasOverlay = verificaReferencias(empaquetado);
  if (rotasOverlay.length > 0) {
    falla(`referencias rotas en el overlay empaquetado:\n${rotasOverlay.map((r) => `  · ${r}`).join('\n')}`);
  }
  const n = ficheros(empaquetado).length;
  console.log(`overlay empaquetado en overlay-empaquetado/ (${n} ficheros)`);
  return { sello, ficheros: n };
}

const esPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esPrincipal) {
  const i = process.argv.indexOf('--version');
  const version = i !== -1 ? process.argv[i + 1] : JSON.parse(readFileSync(join(PROYECTO, 'package.json'), 'utf8')).version;
  const origen = process.env.EASY_OVERLAY ? resolve(PROYECTO, process.env.EASY_OVERLAY) : resolve(PROYECTO, '..', 'overlay');
  montaTodo({ version, origen });
}
