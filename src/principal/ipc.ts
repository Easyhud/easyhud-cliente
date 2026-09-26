/**
 * Registro de los canales IPC del puente (especificación §4.1).
 *
 * Todos existen en los dos modos para que el puente nunca quede colgado, pero
 * los del observador responden en el jugador con el texto de la
 * especificación (o no hacen nada).
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

  ipcMain.on(CANALES.conecta, (_e, token: unknown, grupo: unknown) => observador?.conecta(token, grupo));
  ipcMain.on(CANALES.arrancaOverlay, (_e, token: unknown, grupo: unknown) => observador?.arrancaOverlayLocal(token, grupo));
  ipcMain.on(CANALES.paraOverlay, () => void observador?.local.para());
  ipcMain.on(CANALES.arrancaSala, () => observador?.lector.arranca(1000));
  ipcMain.on(CANALES.paraSala, () => observador?.lector.para());

  ipcMain.handle(CANALES.creaSala, () =>
    observador ? observador.creaSala() : { ok: false, error: 'Solo el observador crea la sala.' },
  );
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
