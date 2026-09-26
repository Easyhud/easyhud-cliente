/**
 * Builds de los tres perfiles (especificación §9.2).
 *
 *   node scripts/construye.mjs normal [--publicar]
 *   node scripts/construye.mjs observer http://2.24.200.205:5100
 *   node scripts/construye.mjs player   http://2.24.200.205:5100
 *
 * limpiar (app y la carpeta de salida) → guarda de identidad → compilar →
 * montar overlay → escribir `app/perfil.json` → ow-electron-builder.
 *
 * El perfil se escribe en la SALIDA compilada, no en el código fuente: no hay
 * nada que "restaurar a normal" después, y un build que falle a medias no
 * deja el proyecto con otro perfil (defecto 11.33 del cliente anterior).
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ejecuta, PROYECTO, prepara } from './comun.mjs';

const require = createRequire(import.meta.url);
const [modo, ...resto] = process.argv.slice(2);
const publicar = resto.includes('--publicar');
const ip = resto.find((a) => !a.startsWith('--')) ?? null;

if (!['normal', 'observer', 'player'].includes(modo)) {
  console.error(`✗ perfil desconocido: ${String(modo)} (normal | observer | player)`);
  process.exit(1);
}
if (modo !== 'normal' && ip === null) {
  console.error(`✗ el perfil ${modo} necesita la URL de ingesta (p. ej. http://2.24.200.205:5100)`);
  process.exit(1);
}

prepara({ limpiar: [modo === 'player' ? 'dist-player' : 'dist'] });

const { perfilPara } = await import(pathToFileURL(join(PROYECTO, 'app', 'principal', 'perfil.js')).href);
const perfil = perfilPara(modo, ip);
writeFileSync(join(PROYECTO, 'app', 'perfil.json'), `${JSON.stringify(perfil, null, 2)}\n`);
console.log(`perfil quemado: ${JSON.stringify(perfil)}`);

const cli = join(require.resolve('@overwolf/ow-electron-builder/package.json'), '..', 'cli.js');
ejecuta(process.execPath, [cli, '--config', join('build', `builder.${modo}.cjs`), '--win', '--publish', publicar ? 'always' : 'never']);
