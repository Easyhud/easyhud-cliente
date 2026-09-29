/**
 * Los canales IPC entre el programa y el panel.
 *
 * Contrato normativo: el shell del panel (`overlay/panel/js/shell.js`) llama a
 * `window.electronAPI.<método>` y el preload traduce cada método a UNO de
 * estos canales (sin canal genérico). El preload (`src/preload/puente.cts`)
 * repite los nombres porque corre aislado y no puede importar este módulo;
 * la prueba `test/ipc.test.ts` comprueba que ambos casan.
 */

import type { Coleccion, NombreColeccion } from './coleccion.ts';

export const CANALES = {
  perfil: 'get-build-profile',
  urlObs: 'get-obs-url',
  conecta: 'conecta',
  arrancaOverlay: 'arranca-overlay-local',
  paraOverlay: 'para-overlay-local',
  arrancaSala: 'arranca-lector-sala',
  paraSala: 'para-lector-sala',
  salaLocal: 'sala-local',
  estadoJuego: 'set-game-status',
  serieFin: 'serie-mapa-fin',
  creaSala: 'crea-sala',
  llamaJugadores: 'llamar-jugadores',
  aplicaAtajos: 'aplica-atajos',
  suspendeAtajos: 'suspende-atajos',
  operador: 'operador-overlay',
  minimizar: 'ventana-minimizar',
  maximizar: 'ventana-maximizar',
  cerrar: 'ventana-cerrar',
  enlaceExterno: 'open-external-link',
} as const;

export const canalDb = (col: NombreColeccion, op: 'list' | 'create' | 'update' | 'delete') => `db:${col}:${op}`;

export type RespuestaDb = { ok: true; items?: unknown[]; item?: unknown } | { ok: false; error: string };

/**
 * Los manejadores de los doce canales `db:*`. Nunca lanzan: cualquier
 * excepción vuelve como `{ok: false, error}`.
 */
export function manejadoresDb(
  colecciones: Record<NombreColeccion, Coleccion>,
): Map<string, (...args: unknown[]) => Promise<RespuestaDb | { ok: boolean }>> {
  const mapa = new Map<string, (...args: unknown[]) => Promise<RespuestaDb | { ok: boolean }>>();
  const seguro =
    (fn: (...args: unknown[]) => Promise<RespuestaDb | { ok: boolean }>) =>
    async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
  for (const nombre of Object.keys(colecciones) as NombreColeccion[]) {
    const c = colecciones[nombre];
    mapa.set(canalDb(nombre, 'list'), seguro(async () => ({ ok: true, items: c.list() })));
    mapa.set(canalDb(nombre, 'create'), seguro(async (dato) => ({ ok: true, item: await c.create(dato) })));
    mapa.set(
      canalDb(nombre, 'update'),
      seguro(async (id, parche) => {
        const item = await c.update(id, parche);
        return item === null ? { ok: false, error: 'No existe.' } : { ok: true, item };
      }),
    );
    mapa.set(canalDb(nombre, 'delete'), seguro(async (id) => ({ ok: await c.delete(id) })));
  }
  return mapa;
}

/** `open-external-link`: sólo `https:` (antes abría cualquier cosa que mandara la página). */
export function enlaceExternoPermitido(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
