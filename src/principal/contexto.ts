/**
 * Lo que comparten el modo observador y el modo jugador: perfil, almacén,
 * la ventana principal y las tres formas de avisar (título, estado de juego
 * para el panel y diálogos nativos).
 */

import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import type { Almacen } from './almacen.ts';
import { CANALES } from './canales.ts';
import type { ClaseEstado } from './gep/acciones.ts';
import type { Perfil, Rol } from './perfil.ts';
import { log } from './registro.ts';
import type { Recuerdos } from './secreto.ts';
import { FiltroDialogos, padreDeDialogo } from './sistema/robustez.ts';

export interface Contexto {
  version: string;
  desarrollo: boolean;
  empaquetado: boolean;
  perfil: Perfil;
  rol: Rol;
  /** URL de ingesta efectiva (sin normalizar), o `null` (jugador sin IP). */
  ingesta: string | null;
  puertoLocal: number;
  almacen: Almacen;
  recuerdos: Recuerdos;
  claveHenrik: string;
  ventana(): BrowserWindow | null;
}

/** "Estado del programa": título de la ventana y log. */
export function estadoPrograma(ctx: Contexto, mensaje: string, clase: ClaseEstado): void {
  log(`estado: ${mensaje} (${clase})`);
  const v = ctx.ventana();
  if (v && !v.isDestroyed()) v.setTitle(`Easy HUD | ${mensaje}`);
}

/** Estado de juego: al panel por `set-game-status` (lo lee `onEscena`). */
export function estadoJuego(ctx: Contexto, mensaje: string, clase: ClaseEstado): void {
  log(`juego: ${mensaje}`);
  enviaAlPanel(ctx, CANALES.estadoJuego, { message: mensaje, statusType: clase });
}

export function enviaAlPanel(ctx: Contexto, canal: string, dato: unknown): void {
  const v = ctx.ventana();
  if (v && !v.isDestroyed()) v.webContents.send(canal, dato);
}

const filtro = new FiltroDialogos();

/**
 * Un diálogo con botones, colgado de la ventana principal SÓLO si se ve (escondida en la bandeja o
 * minimizada, un diálogo hijo queda detrás de todo y el programa se queda esperando a que alguien lo
 * conteste sin que nadie lo vea). Devuelve el botón pulsado.
 */
export async function muestraDialogo(ctx: Contexto, opciones: MessageBoxOptions): Promise<number> {
  const padre = padreDeDialogo(ctx.ventana());
  const { response } = await (padre !== null ? dialog.showMessageBox(padre, opciones) : dialog.showMessageBox(opciones));
  return response;
}

/** Diálogo nativo que no bloquea el proceso. El mismo aviso abierto dos veces sólo sale una. */
export function dialogo(ctx: Contexto, titulo: string, mensaje: string, tipo: 'warning' | 'error' | 'info' = 'warning'): void {
  log(`diálogo: ${titulo} — ${mensaje.replace(/\n+/g, ' ')}`);
  const clave = `${titulo}\n${mensaje}`;
  if (!filtro.abre(clave)) {
    log('diálogo: ya hay uno igual abierto (o demasiados a la vez), no se repite');
    return;
  }
  const opciones = { type: tipo, title: titulo, message: mensaje, buttons: ['OK'] };
  void muestraDialogo(ctx, opciones)
    .catch((e) => log(`diálogo: no se pudo mostrar (${e instanceof Error ? e.message : String(e)})`))
    .finally(() => filtro.cierra(clave));
}
