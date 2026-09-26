/**
 * Arranque de desarrollo: limpiar → guarda → compilar → montar → lanzar
 * ow-electron con `--development` (y `--auxiliary` si se pasa, para el jugador).
 *
 * Uso: node scripts/desarrollo.mjs [--auxiliary] [--solo-preparar]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROYECTO, prepara } from './comun.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

prepara();
if (args.includes('--solo-preparar')) process.exit(0);

/** El paquete de ow-electron exporta la ruta de su ejecutable. */
const ejecutable = require('@overwolf/ow-electron');
const extra = args.filter((a) => a === '--auxiliary');
const hijo = spawn(ejecutable, ['.', '--development', ...extra], { cwd: PROYECTO, stdio: 'inherit' });
hijo.on('exit', (codigo) => process.exit(codigo ?? 0));
for (const senal of ['SIGINT', 'SIGTERM']) process.on(senal, () => hijo.kill());
