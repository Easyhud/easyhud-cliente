/**
 * Adaptador de GEP (Game Events Provider de Overwolf, paquete `gep` de
 * ow-electron).
 *
 * Única pieza que habla con la API de Overwolf. Entrega cada dato de VALORANT
 * (`{key, value}`) al receptor y no sabe qué significa: eso es cosa de los
 * traductores (`observador.ts`, `jugador.ts`).
 *
 * Señal de diagnóstico: si la identidad de la app no es la que Overwolf
 * reconoce (ver `identidad.json`), GEP se anuncia como versión `0.0.0` y no
 * entrega ni un evento, sin error. Se deja escrito en el log bien visible.
 *
 * Robustez (el operador veía que GEP no llegaba nunca a "Ready" hasta matar
 * el proceso):
 *   · se engancha antes de cualquier espera del arranque (antes se enganchaba
 *     DESPUÉS de la comprobación de actualizaciones, que puede tardar 8 s o
 *     quedarse esperando a que el operador conteste el diálogo; si el `ready`
 *     de `gep` salía en ese rato, se perdía para siempre);
 *   · si aun así el `ready` ya pasó (la instancia `gep` ya existe), se da por
 *     listo en vez de esperar un evento que no se repetirá;
 *   · vigía: si en `esperaListoMs` no llega, se deja escrito, se fuerza la
 *     actualización pendiente del gestor si la hay (`relaunch`) y se avisa a
 *     quien llama (`sinListo`) para que ofrezca reiniciar o cerrar restos;
 *   · `crashed` sin recuperación y `failed-to-initialize` de `gep` avisan igual.
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
  /**
   * GEP no llegó a `ready` en el plazo (o el paquete se cayó sin poder
   * recuperarse). Quien llama decide qué ofrecer al usuario. `intento` empieza en 1.
   */
  sinListo?(motivo: string, intento: number): void;
  log(texto: string): void;
  error(texto: string, e?: unknown): void;
}

export interface OpcionesGep {
  /** Plazo para el `ready` de GEP antes de avisar (por defecto 45 s). */
  esperaListoMs?: number;
  /** Tras avisar, cada cuánto se vuelve a avisar si sigue sin llegar (por defecto 120 s). */
  reavisoMs?: number;
}

/** Lo que se puede preguntar al adaptador en marcha. */
export interface EstadoGep {
  readonly listo: boolean;
  readonly version: string;
  /** Si GEP detectó VALORANT alguna vez en esta sesión. */
  readonly detectado: boolean;
  /** Deja de vigilar (al salir). */
  para(): void;
}

type Gestor = overwolf.packages.OverwolfPackageManager;

/** Lo mínimo del gestor de paquetes de ow-electron que se usa (así se prueba con un falso). */
export type GestorPaquetes = Pick<Gestor, 'on' | 'gep'> & Partial<Pick<Gestor, 'hasPendingUpdates' | 'relaunch'>>;

function esDato(d: unknown): d is { gameId?: number; key: string; value: unknown } {
  return typeof d === 'object' && d !== null && typeof (d as { key?: unknown }).key === 'string';
}

export function iniciaGep(app: App, r: ReceptorGep, o: OpcionesGep = {}): EstadoGep | null {
  const paquetes = (app as overwolf.OverwolfApp).overwolf?.packages;
  if (paquetes === undefined) {
    r.error('este Electron no trae la API de Overwolf (¿se lanzó con electron en vez de ow-electron?)');
    return null;
  }
  return vigilaPaquetes(paquetes, r, o);
}

export function vigilaPaquetes(paquetes: GestorPaquetes, r: ReceptorGep, o: OpcionesGep = {}): EstadoGep {
  let habilitado = false;
  let detecciones = 0;
  let listo = false;
  let version = '';
  let intentos = 0;
  let relanzado = false;
  let parado = false;
  let vigia: NodeJS.Timeout | null = null;
  const inicio = Date.now();

  const quitaVigia = () => {
    if (vigia !== null) clearTimeout(vigia);
    vigia = null;
  };
  const programaVigia = (ms: number) => {
    quitaVigia();
    if (parado) return;
    vigia = setTimeout(sinReady, ms);
    vigia.unref?.();
  };

  function sinReady(): void {
    vigia = null;
    if (listo || parado) return;
    intentos += 1;
    const segundos = Math.round((Date.now() - inicio) / 1000);
    r.error(`GEP sigue sin estar listo tras ${segundos} s (aviso ${intentos})`);
    r.estado('GEP Not Ready', 'warn');
    let pendiente = false;
    try {
      pendiente = paquetes.hasPendingUpdates?.().hasPendingUpdate === true;
    } catch (e) {
      r.error('hasPendingUpdates falló', e);
    }
    if (pendiente && !relanzado && paquetes.relaunch) {
      relanzado = true;
      r.log('hay una actualización de paquetes pendiente: se relanza el gestor de paquetes');
      try {
        paquetes.relaunch();
      } catch (e) {
        r.error('relaunch del gestor de paquetes falló', e);
      }
    }
    r.sinListo?.(pendiente ? 'actualización de paquetes pendiente' : 'GEP no respondió', intentos);
    programaVigia(o.reavisoMs ?? 120_000);
  }

  paquetes.on('failed-to-initialize', (_e, nombre) => {
    r.log(`paquete de Overwolf sin inicializar: ${String(nombre)}`);
    if (String(nombre) === 'gep' && !listo) programaVigia(0);
  });
  paquetes.on('package-update-pending', (_e, info) => {
    const nombres = Array.isArray(info) ? info.map((p) => p?.name) : [info as unknown];
    if (nombres.includes('gep')) r.estado('GEP Updating', 'warn');
  });
  paquetes.on('updated', (_e, nombre, v) => r.log(`paquete de Overwolf actualizado: ${String(nombre)} ${String(v)}`));
  paquetes.on('crashed', (_e, recuperable) => {
    r.error(`un paquete de Overwolf se cayó (${recuperable ? 'se relanza solo' : 'sin recuperación'})`);
    if (!recuperable) {
      listo = false;
      habilitado = false;
      r.estado('GEP Crashed', 'danger');
      programaVigia(0);
    }
  });

  /**
   * `tardio`: se dio por listo sin haber visto el `ready` (ya existía la
   * instancia). En ese caso no se anuncia hasta que `setRequiredFeatures`
   * responde bien, y un fallo no es "versión incompatible": se vuelve a esperar.
   */
  const alListo = (v: string, tardio = false) => {
    listo = true;
    version = v;
    quitaVigia();
    r.log(`GEP listo, versión ${v} (${((Date.now() - inicio) / 1000).toFixed(1)} s tras engancharse)`);
    if (v === '0.0.0') {
      r.error('GEP 0.0.0: Overwolf no reconoce la identidad de la app y NO entregará eventos (ver identidad.json)');
    }
    if (!tardio) r.listo(v);

    const gep = paquetes.gep;
    gep.removeAllListeners();
    gep.setRequiredFeatures(VALORANT, FEATURES).then(
      () => {
        if (tardio && listo) r.listo(v);
      },
      (e: unknown) => {
        r.error('setRequiredFeatures falló', e);
        if (!tardio) {
          r.versionIncompatible(v);
          return;
        }
        listo = false;
        r.log('GEP no estaba listo de verdad: se sigue esperando su "ready"');
        programaVigia(o.esperaListoMs ?? 45_000);
      },
    );

    gep.on('game-detected', (e, id, nombreJuego) => {
      if (id !== VALORANT) return;
      r.log(`juego detectado: ${nombreJuego} (${id})`);
      e.enable();
      habilitado = true;
      detecciones += 1;
      if (detecciones >= 2) r.estado('Ready', 'info');
    });
    gep.on('game-exit', (_e: unknown, id: number) => {
      if (id === VALORANT) r.log('GEP: VALORANT se cerró');
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
  };

  paquetes.on('ready', (_e, nombre, v) => {
    if (nombre !== 'gep') return;
    alListo(String(v));
  });

  // ¿El `ready` de gep pasó antes de engancharse? La instancia sólo existe tras él.
  let yaEstaba: unknown;
  try {
    yaEstaba = paquetes.gep;
  } catch {
    yaEstaba = undefined;
  }
  if (yaEstaba !== undefined && yaEstaba !== null) {
    r.log('el paquete GEP ya estaba listo al engancharse (su "ready" se había perdido): se continúa igual');
    alListo('desconocida', true);
  } else {
    r.log('esperando a que el paquete GEP de Overwolf esté listo…');
    programaVigia(o.esperaListoMs ?? 45_000);
  }

  return {
    get listo() {
      return listo;
    },
    get version() {
      return version;
    },
    get detectado() {
      return detecciones > 0;
    },
    para() {
      parado = true;
      quitaVigia();
    },
  };
}
