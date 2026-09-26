/**
 * Pasos comunes al arranque de desarrollo y a los builds:
 * limpiar → guarda de identidad → compilar → montar el overlay.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compruebaIdentidad } from './comprueba-identidad.mjs';
import { montaTodo } from './monta-overlay.mjs';

export const PROYECTO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export const version = () => JSON.parse(readFileSync(join(PROYECTO, 'package.json'), 'utf8')).version;

export function ejecuta(programa, args) {
  const r = spawnSync(programa, args, { cwd: PROYECTO, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ falló: ${[programa, ...args].join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

export function prepara({ limpiar = [] } = {}) {
  for (const d of ['app', ...limpiar]) rmSync(join(PROYECTO, d), { recursive: true, force: true });

  const fallos = compruebaIdentidad();
  if (fallos.length > 0) {
    console.error('✗ La identidad de Overwolf NO coincide con la aprobada:');
    for (const f of fallos) console.error(`  · ${f}`);
    console.error('\nCon otra identidad GEP carga un stub 0.0.0 y NO entrega eventos. Ver README.');
    process.exit(1);
  }
  console.log('✓ identidad de GEP intacta');

  ejecuta(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);

  const origen = process.env.EASY_OVERLAY ? resolve(PROYECTO, process.env.EASY_OVERLAY) : resolve(PROYECTO, '..', 'overlay');
  montaTodo({ version: version(), origen });
}
