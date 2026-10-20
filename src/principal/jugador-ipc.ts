/**
 * La ventana del jugador: estado del programa, «copiar diagnóstico» y «abrir los logs».
 * (La cámara tiene su propio IPC en `camara/ipc.ts`.)
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, clipboard, ipcMain, shell } from 'electron';
import type { ModoJugador } from './modo-jugador.ts';

export const CANAL_JUGADOR_ESTADO = 'jugador-estado';
export const CANAL_JUGADOR_COPIA = 'jugador-copia-diagnostico';
export const CANAL_JUGADOR_LOGS = 'jugador-abre-logs';
export const CANAL_JUGADOR_PRUEBA = 'jugador-prueba-red';
export const CANAL_JUGADOR_INFORME_ENVIAR = 'jugador-informe-enviar';
export const CANAL_JUGADOR_INFORME_GUARDAR = 'jugador-informe-guardar';
export const CANAL_JUGADOR_FIREWALL = 'jugador-firewall';
export const CANAL_JUGADOR_AJUSTES_CAMARA = 'jugador-ajustes-camara';

export const CANAL_JUGADOR_SALIR = 'jugador-salir';

export function registraIpcJugador(jugador: ModoJugador, carpetaLogs: string, salir: () => void): void {
  ipcMain.handle(CANAL_JUGADOR_ESTADO, () => jugador.estadoUI());
  ipcMain.handle(CANAL_JUGADOR_COPIA, () => {
    clipboard.writeText(jugador.textoDiagnostico());
    return true;
  });
  ipcMain.handle(CANAL_JUGADOR_LOGS, async () => (await shell.openPath(carpetaLogs)) === '');
  // Cerrar el programa DE VERDAD (cerrar la ventana sólo la esconde: sigue en la bandeja).
  ipcMain.handle(CANAL_JUGADOR_SALIR, () => {
    setTimeout(salir, 100);
    return true;
  });
  // La caja negra: el informe completo, mandado al operador o guardado en un fichero.
  ipcMain.handle(CANAL_JUGADOR_INFORME_ENVIAR, () => jugador.enviaInforme());
  ipcMain.handle(CANAL_JUGADOR_INFORME_GUARDAR, async () => {
    const informe = await jugador.generaInforme();
    const hoy = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const nick = (informe.jugador || 'jugador').replace(/[^\w#-]+/g, '_');
    const ruta = join(app.getPath('desktop'), `EasyHUD-informe-${nick}-${hoy}.json`);
    writeFileSync(ruta, JSON.stringify(informe, null, 2));
    shell.showItemInFolder(ruta);
    return ruta;
  });
  // La autoprueba de red (nombre, puerto, web, WebSocket) y el permiso del Firewall de Windows.
  ipcMain.handle(CANAL_JUGADOR_PRUEBA, () => jugador.ejecutaPruebaRed());
  ipcMain.handle(CANAL_JUGADOR_FIREWALL, () => jugador.permiteFirewall());
  // Los ajustes de privacidad de la cámara de Windows (si el permiso está denegado).
  ipcMain.handle(CANAL_JUGADOR_AJUSTES_CAMARA, () => shell.openExternal('ms-settings:privacy-webcam').then(() => true, () => false));
}
