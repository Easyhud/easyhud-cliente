/**
 * Dónde está cada cosa, empaquetado o en desarrollo.
 *
 *   salida compilada   app/                  (dentro del asar al empaquetar)
 *     principal/       este proceso
 *     preload/         el puente
 *     renderer/        el panel y la página del jugador (scripts/monta-overlay.mjs)
 *   overlay completo   resources/overlay     (empaquetado)
 *                      overlay-empaquetado/  (desarrollo, lo genera el mismo script)
 *   icono              resources/icon.ico    ·  build/icon.ico
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `app/` (la carpeta de la salida compilada). */
export const SALIDA = resolve(import.meta.dirname, '..');
/** La raíz del proyecto en desarrollo (junto a `package.json`). */
export const PROYECTO = resolve(SALIDA, '..');

export const PRELOAD = join(SALIDA, 'preload', 'puente.cjs');
export const PANEL = join(SALIDA, 'renderer', 'panel', 'index.html');
export const PAGINA_JUGADOR = join(SALIDA, 'renderer', 'jugador.html');

export function raizOverlay(empaquetado: boolean): string {
  return empaquetado ? join(process.resourcesPath, 'overlay') : join(PROYECTO, 'overlay-empaquetado');
}

/** Primera ruta de icono que exista, o `null` (la bandeja usará un icono vacío). */
export function rutaIcono(empaquetado: boolean): string | null {
  const candidatas = empaquetado
    ? [join(process.resourcesPath, 'icon.ico'), join(process.resourcesPath, 'build', 'icon.ico'), join(SALIDA, 'icon.ico')]
    : [join(PROYECTO, 'build', 'icon.ico')];
  return candidatas.find((c) => existsSync(c)) ?? null;
}
