/**
 * El botón de la cámara del jugador (ventana y bandeja): estado y alternar.
 * La cámara es privada: sólo el jugador la enciende, y siempre empieza apagada.
 */

import { ipcMain } from 'electron';
import type { Almacen } from '../almacen.ts';
import type { ModoJugador } from '../modo-jugador.ts';

export const CANAL_CAMARA_ESTADO = 'camara-estado';
export const CANAL_CAMARA_ALTERNA = 'camara-alterna';
export const CANAL_CAMARA_DISPOSITIVO = 'camara-dispositivo';
export const CANAL_CAMARA_FIJA_DISPOSITIVO = 'camara-fija-dispositivo';

export function registraIpcCamara(jugador: ModoJugador, almacen: Almacen, alCambiar: () => void): void {
  ipcMain.handle(CANAL_CAMARA_ESTADO, () => jugador.camara.estado());
  ipcMain.handle(CANAL_CAMARA_ALTERNA, () => {
    jugador.alternaCamara();
    alCambiar();
    return jugador.camara.estado();
  });

  // Qué cámara usar (la etiqueta, o parte de ella; vacío = la predeterminada).
  ipcMain.handle(CANAL_CAMARA_DISPOSITIVO, () => almacen.lee('camara').dispositivo ?? '');
  ipcMain.handle(CANAL_CAMARA_FIJA_DISPOSITIVO, async (_e, etiqueta: unknown) => {
    const dispositivo = typeof etiqueta === 'string' ? etiqueta.slice(0, 200) : '';
    await almacen.escribe('camara', { dispositivo });
    jugador.camara.reevalua(); // si estaba emitiendo, reabre con la cámara nueva
    return dispositivo;
  });
}
