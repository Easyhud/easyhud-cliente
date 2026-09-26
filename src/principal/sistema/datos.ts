/**
 * Dónde viven los datos del usuario (especificación §1.2 y §5.1).
 *
 * Ahí están el `localStorage` del panel (sesión, atajos) y la carpeta
 * `storage/` (base local, secreto de reconexión…). Si el programa nuevo
 * resolviera otra carpeta, el operador perdería todo al actualizar. Reglas:
 *
 *   1. Jugador: SIEMPRE `%APPDATA%\spectra-client-player` (normativo). Así no
 *      comparte candado de instancia única con el observador.
 *   2. `EASY_DIR_DATOS` en el entorno, si está: manda (para soporte y para
 *      confirmar en una máquina real sin recompilar).
 *   3. La carpeta por defecto de Electron, si ya tiene `storage/` o `Local Storage/`.
 *   4. La primera carpeta heredada que tenga datos, en este orden:
 *      `spectra-client`, `Spectra Client`, `Easy HUD`. Cubre las dos formas en
 *      que Electron pudo nombrarla en el cliente anterior (por `name` del
 *      package.json o por `productName`, que el build `normal` tenía como
 *      "Easy HUD").
 *   5. Si no hay nada: la de Electron por defecto (instalación nueva).
 *
 * PENDIENTE DE CONFIRMAR en una máquina con el cliente 0.3.3 instalado cuál
 * de las heredadas es la real (ver README).
 */

import { join } from 'node:path';

export const CARPETA_JUGADOR = 'spectra-client-player';
export const HEREDADAS = ['spectra-client', 'Spectra Client', 'Easy HUD'] as const;

export interface EntradaDatos {
  rol: 'observador' | 'jugador';
  /** `%APPDATA%` (Electron: `app.getPath('appData')`). */
  appData: string;
  /** Lo que Electron resolvería solo (`app.getPath('userData')`). */
  porDefecto: string;
  forzada?: string;
  /** ¿Esa carpeta tiene datos del programa? */
  tieneDatos: (carpeta: string) => boolean;
}

export function eligeDirectorioDatos(e: EntradaDatos): { carpeta: string; motivo: string } {
  if (e.rol === 'jugador') return { carpeta: join(e.appData, CARPETA_JUGADOR), motivo: 'perfil jugador' };
  if (e.forzada !== undefined && e.forzada !== '') return { carpeta: e.forzada, motivo: 'EASY_DIR_DATOS' };
  if (e.tieneDatos(e.porDefecto)) return { carpeta: e.porDefecto, motivo: 'por defecto, con datos' };
  for (const nombre of HEREDADAS) {
    const c = join(e.appData, nombre);
    if (c !== e.porDefecto && e.tieneDatos(c)) return { carpeta: c, motivo: `heredada (${nombre})` };
  }
  return { carpeta: e.porDefecto, motivo: 'por defecto (instalación nueva)' };
}
