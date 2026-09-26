/**
 * Lo que comparten el modo observador y el modo jugador: perfil, almacén,
 * la ventana principal y las tres formas de avisar (título, estado de juego
 * para el panel y diálogos nativos).
 */

import { dialog, type BrowserWindow } from 'electron';
import type { Almacen } from './almacen.ts';
import { CANALES } from './canales.ts';
import type { ClaseEstado } from './gep/acciones.ts';
import type { Perfil, Rol } from './perfil.ts';
import { log } from './registro.ts';
import type { Recuerdos } from './secreto.ts';

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

/** Diálogo nativo que no bloquea el proceso. */
export function dialogo(ctx: Contexto, titulo: string, mensaje: string, tipo: 'warning' | 'error' | 'info' = 'warning'): void {
  log(`diálogo: ${titulo} — ${mensaje.replace(/\n+/g, ' ')}`);
  const v = ctx.ventana();
  const opciones = { type: tipo, title: titulo, message: mensaje, buttons: ['OK'] };
  void (v && !v.isDestroyed() ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones));
}
