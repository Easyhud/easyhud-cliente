/**
 * Adaptador de GEP (Game Events Provider de Overwolf, paquete `gep` de
 * ow-electron). Especificación §2.1.
 *
 * Única pieza que habla con la API de Overwolf. Entrega cada dato de VALORANT
 * (`{key, value}`) al receptor y no sabe qué significa: eso es cosa de los
 * traductores (`observador.ts`, `jugador.ts`).
 *
 * Señal de diagnóstico: si la identidad de la app no es la que Overwolf
 * reconoce (ver `identidad.json`), GEP se anuncia como versión `0.0.0` y no
 * entrega ni un evento, sin error. Se deja escrito en el log bien visible.
 */

import type { App } from 'electron';
import type { overwolf } from '@overwolf/ow-electron';
import type { ClaseEstado, DatoGep } from './acciones.ts';

export const VALORANT = 21640;
export const FEATURES = ['match_info', 'me', 'game_info'];

export interface ReceptorGep {
  estado(mensaje: string, clase: ClaseEstado): void;
  /** GEP listo con su versión. */
  listo(version: string): void;
  info(dato: DatoGep): void;
  evento(dato: DatoGep): void;
  /** No se pudieron fijar las features: la versión de GEP no sirve. */
  versionIncompatible(version: string): void;
  log(texto: string): void;
  error(texto: string, e?: unknown): void;
}

function esDato(d: unknown): d is { gameId?: number; key: string; value: unknown } {
  return typeof d === 'object' && d !== null && typeof (d as { key?: unknown }).key === 'string';
}

export function iniciaGep(app: App, r: ReceptorGep): void {
  const paquetes = (app as overwolf.OverwolfApp).overwolf?.packages;
  if (paquetes === undefined) {
    r.error('este Electron no trae la API de Overwolf (¿se lanzó con electron en vez de ow-electron?)');
    return;
  }

  let habilitado = false;
  let detecciones = 0;

  paquetes.on('failed-to-initialize', (_e, nombre) => r.log(`paquete de Overwolf sin inicializar: ${String(nombre)}`));
  paquetes.on('package-update-pending', (_e, info) => {
    const nombres = Array.isArray(info) ? info.map((p) => p?.name) : [info as unknown];
    if (nombres.includes('gep')) r.estado('GEP Updating', 'warn');
  });

  paquetes.on('ready', (_e, nombre, version) => {
    if (nombre !== 'gep') return;
    r.log(`GEP listo, versión ${version}`);
    if (version === '0.0.0') {
      r.error('GEP 0.0.0: Overwolf no reconoce la identidad de la app y NO entregará eventos (ver identidad.json)');
    }
    r.listo(version);

    const gep = paquetes.gep;
    gep.removeAllListeners();
    gep.setRequiredFeatures(VALORANT, FEATURES).catch((e: unknown) => {
      r.error('setRequiredFeatures falló', e);
      r.versionIncompatible(version);
    });

    gep.on('game-detected', (e, id, nombreJuego) => {
      if (id !== VALORANT) return;
      r.log(`juego detectado: ${nombreJuego} (${id})`);
      e.enable();
      habilitado = true;
      detecciones += 1;
      if (detecciones >= 2) r.estado('Ready', 'info');
    });

    const reparte = (clase: 'info' | 'evento', datos: unknown[]) => {
      if (!habilitado) return;
      for (const d of datos) {
        if (!esDato(d) || (d.gameId !== undefined && d.gameId !== VALORANT)) continue;
        try {
          if (clase === 'info') r.info({ key: d.key, value: d.value });
          else r.evento({ key: d.key, value: d.value });
        } catch (e) {
          r.error(`procesando ${clase} ${d.key}`, e);
        }
      }
    };
    gep.on('new-info-update', (_e: unknown, gameId: number, ...datos: unknown[]) => {
      if (gameId === VALORANT) reparte('info', datos);
    });
    gep.on('new-game-event', (_e: unknown, gameId: number, ...datos: unknown[]) => {
      if (gameId === VALORANT) reparte('evento', datos);
    });
    gep.on('elevated-privileges-required', (_e, id) => {
      r.log(`el juego ${id} corre como administrador: Easy HUD también debe hacerlo para recibir eventos`);
    });
    gep.on('error', (_e: unknown, id: number, mensaje: string) => {
      r.error(`error de GEP (juego ${id}): ${mensaje}. GEP queda deshabilitado hasta la próxima detección`);
      habilitado = false;
    });
  });
}
