/**
 * Registro de los canales IPC del puente.
 *
 * Todos existen en los dos modos para que el puente nunca quede colgado, pero
 * los del observador responden en el jugador con el texto acordado para ese
 * caso (o no hacen nada).
 */

import { BrowserWindow, ipcMain, shell, type IpcMainEvent } from 'electron';
import { CANALES, enlaceExternoPermitido, manejadoresDb } from './canales.ts';
import type { Coleccion, NombreColeccion } from './coleccion.ts';
import type { Contexto } from './contexto.ts';
import type { ModoObservador } from './modo-observador.ts';
import { log } from './registro.ts';

export interface Ventana {
  cerrar(v: BrowserWindow): void;
}

export function registraIpc(
  ctx: Contexto,
  colecciones: Record<NombreColeccion, Coleccion>,
  observador: ModoObservador | null,
  ventana: Ventana,
): void {
  const desde = (e: IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.on(CANALES.perfil, (e) => {
    e.returnValue = ctx.perfil;
  });
  ipcMain.on(CANALES.urlObs, (e) => {
    e.returnValue = observador?.urlObs ?? `http://localhost:${ctx.puertoLocal}/`;
  });

  // Sólo en desarrollo: `EASY_ENDPOINT=http://localhost:5200` hace que el panel lea de un servidor local.
  ipcMain.on(CANALES.endpointDatos, (e) => {
    e.returnValue = ctx.desarrollo ? (process.env.EASY_ENDPOINT ?? '') : '';
  });

  ipcMain.on(CANALES.conecta, (_e, token: unknown, grupo: unknown) => observador?.conecta(token, grupo));
  ipcMain.on(CANALES.arrancaOverlay, (_e, token: unknown, grupo: unknown) => observador?.arrancaOverlayLocal(token, grupo));
  ipcMain.on(CANALES.paraOverlay, () => observador?.paraOverlayLocal());
  ipcMain.on(CANALES.arrancaSala, () => observador?.arrancaLector());
  ipcMain.on(CANALES.paraSala, () => observador?.paraLector());

  ipcMain.handle(CANALES.creaSala, () =>
    observador ? observador.creaSala() : { ok: false, error: 'Solo el observador crea la sala.' },
  );
  /*
   * «Reconnect everything» desde el panel (el mismo gesto que Ctrl+Alt+R y la bandeja): reabre el servidor, el overlay
   * local y el lector de sala, y devuelve qué ha hecho para contárselo al operador. Nunca lanza: un fallo vuelve como
   * `{ ok: false, error }`. Pasados unos segundos se repiten las comprobaciones de arranque, como con el atajo.
   */
  ipcMain.handle(CANALES.reconectaTodo, async () => {
    if (!observador) return { ok: false, error: 'Solo el observador puede reconectarlo todo.' };
    try {
      const hecho = await observador.reconectaTodo();
      setTimeout(() => void observador.ejecutaComprobaciones('problemas'), 8000).unref();
      return { ok: true, hecho };
    } catch (e) {
      log(`reconecta-todo falló: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.on(CANALES.colocaJugadores, (_e, lista: unknown) => observador?.colocaJugadores(lista));
  ipcMain.handle(CANALES.llamaJugadores, (_e, puuids: unknown) =>
    observador ? observador.llamaJugadores(puuids ?? []) : { ok: false, error: 'Solo el observador llama a los jugadores.' },
  );

  for (const [canal, fn] of manejadoresDb(colecciones)) {
    ipcMain.handle(canal, (_e, ...args: unknown[]) => fn(...args));
  }

  ipcMain.on(CANALES.aplicaAtajos, (_e, atajos: unknown) => observador?.aplicaAtajos(atajos));
  ipcMain.on(CANALES.suspendeAtajos, () => observador?.desactivaAtajos());
  ipcMain.on(CANALES.operador, (_e, mostrar: unknown) => observador?.operador.muestra(mostrar === true));

  ipcMain.on(CANALES.minimizar, (e) => desde(e)?.minimize());
  ipcMain.on(CANALES.maximizar, (e) => {
    const v = desde(e);
    if (v === null) return;
    if (v.isMaximized()) v.unmaximize();
    else v.maximize();
  });
  ipcMain.on(CANALES.cerrar, (e) => {
    const v = desde(e);
    if (v !== null) ventana.cerrar(v);
  });
  ipcMain.on(CANALES.enlaceExterno, (_e, url: unknown) => {
    if (enlaceExternoPermitido(url)) void shell.openExternal(url);
    else log(`open-external-link rechazado (sólo https): ${String(url).slice(0, 80)}`);
  });
}
