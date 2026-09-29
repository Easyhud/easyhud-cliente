/**
 * Dónde viven los datos del usuario.
 *
 * Ahí están el `localStorage` del panel (sesión, atajos) y la carpeta
 * `storage/` (base local, secreto de reconexión…). Carpetas fijas, con nombre
 * propio, independientes de la identidad de Overwolf del paquete:
 *
 *   1. Jugador: `%APPDATA%\EasyHUD-Jugador`. Separada del observador para que
 *      no compartan candado de instancia única y puedan correr a la vez.
 *   2. Observador: `EASY_DIR_DATOS` en el entorno, si está (soporte y pruebas);
 *      si no, `%APPDATA%\EasyHUD`.
 */

import { join } from 'node:path';

export const CARPETA_OBSERVADOR = 'EasyHUD';
export const CARPETA_JUGADOR = 'EasyHUD-Jugador';

export interface EntradaDatos {
  rol: 'observador' | 'jugador';
  /** `%APPDATA%` (Electron: `app.getPath('appData')`). */
  appData: string;
  forzada?: string;
}

export function eligeDirectorioDatos(e: EntradaDatos): { carpeta: string; motivo: string } {
  if (e.rol === 'jugador') return { carpeta: join(e.appData, CARPETA_JUGADOR), motivo: 'perfil jugador' };
  if (e.forzada !== undefined && e.forzada !== '') return { carpeta: e.forzada, motivo: 'EASY_DIR_DATOS' };
  return { carpeta: join(e.appData, CARPETA_OBSERVADOR), motivo: 'observador' };
}
