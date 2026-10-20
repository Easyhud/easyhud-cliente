/**
 * Colocar a cada jugador en SU lado de la sala personalizada (beta, ESCRIBE sobre el cliente de Riot).
 *
 * El panel sabe en qué equipo juega cada jugador y qué equipo ataca; el anfitrión de la sala (el
 * observador) puede mover a cualquiera con la API local, igual que arrastrarlo a mano: es el mismo
 * `customgamemembership` que ya usa `crea-sala.ts` para pasarse a espectador.
 *
 * ZONA GRIS: API local no oficial del cliente de Riot (ver `contexto.ts`).
 *
 * Qué hace y qué NO hace:
 *   · sólo mueve a quien YA está en la sala y en el lado equivocado (no invita a nadie);
 *   · nunca mueve a los coaches ni al propio observador;
 *   · reintenta con tope y con espera (si Riot lo rechaza —p. ej. no eres anfitrión— no insiste sin fin);
 *   · no toca nada si la partida ya está en marcha o buscando.
 */

import type { ResolutorRiot } from './contexto.ts';
import { pide } from './peticion.ts';
import { leeParty, type Sala } from './sala.ts';

export type EquipoRiot = 'TeamOne' | 'TeamTwo';

/** Quién debe estar en qué lado. `TeamTwo` = Attackers, `TeamOne` = Defenders (como en la sala de Riot). */
export interface Colocacion {
  puuid: string;
  equipo: EquipoRiot;
}

const MAX_JUGADORES = 20;
const PUUID = /^[0-9a-f-]{8,64}$/i;

/** Valida lo que manda el panel (es entrada no fiable): lista acotada de `{puuid, equipo}`. */
export function leeColocacion(carga: unknown): Colocacion[] {
  if (!Array.isArray(carga)) return [];
  const salida: Colocacion[] = [];
  for (const e of carga.slice(0, MAX_JUGADORES)) {
    if (typeof e !== 'object' || e === null) continue;
    const { puuid, equipo } = e as { puuid?: unknown; equipo?: unknown };
    if (typeof puuid !== 'string' || !PUUID.test(puuid)) continue;
    if (equipo !== 'TeamOne' && equipo !== 'TeamTwo') continue;
    if (!salida.some((x) => x.puuid === puuid)) salida.push({ puuid, equipo });
  }
  return salida;
}

/** ¿Está la sala en un estado en el que mover gente tiene sentido? (no con la partida en marcha ni buscando) */
export function salaMovible(sala: Sala): boolean {
  const estado = typeof sala.estado === 'string' ? sala.estado : '';
  return !/MATCHMAKING|IN_MATCH|STARTING|PREGAME|INGAME/i.test(estado);
}

/**
 * Los movimientos que hacen falta: los que están en la sala (jugando o de espectadores) en un lado distinto
 * del que les toca. Puro: se prueba sin Riot.
 */
export function planDeMovimientos(sala: Sala, deseado: Colocacion[], propio = ''): Colocacion[] {
  const ladoActual = new Map<string, EquipoRiot | 'espectador'>();
  for (const j of sala.equipoUno) ladoActual.set(j.puuid, 'TeamOne');
  for (const j of sala.equipoDos) ladoActual.set(j.puuid, 'TeamTwo');
  for (const j of sala.observadores) ladoActual.set(j.puuid, 'espectador');
  // Los coaches no están en `ladoActual`: no se les toca.
  return deseado.filter((d) => d.puuid !== propio && ladoActual.has(d.puuid) && ladoActual.get(d.puuid) !== d.equipo);
}

export type ResultadoMovimiento = { ok: true } | { ok: false; error: string; estado?: number };

/** Mueve a UN jugador a su lado. */
export async function mueveJugador(
  riot: Pick<ResolutorRiot, 'contexto' | 'olvida'>,
  mov: Colocacion,
): Promise<ResultadoMovimiento> {
  const c = await riot.contexto();
  if (c === null || c.glz === '') return { ok: false, error: 'El cliente de Riot no está abierto.' };
  try {
    const p = await leeParty(c);
    if (p === null) return { ok: false, error: 'No hay party activa.' };
    const r = await pide(`${c.glz}/parties/v1/parties/${p.id}/customgamemembership/${mov.equipo}`, {
      metodo: 'POST',
      cabeceras: c.cabeceras,
      cuerpo: { playerToPutOnTeam: mov.puuid },
    });
    if (r.estado === 401 || r.estado === 403) {
      riot.olvida();
      return { ok: false, error: `Riot rechazó la petición (${r.estado}): ¿eres el anfitrión de la sala?`, estado: r.estado };
    }
    if (r.estado >= 300) return { ok: false, error: `customgamemembership falló (${r.estado}).`, estado: r.estado };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * El colocador: guarda lo que el panel quiere y, en cada lectura de la sala, mueve a quien haga falta. Con
 * espera entre intentos por jugador y un tope, para no martillear la API de Riot.
 */
export class Colocador {
  private deseado: Colocacion[] = [];
  private ultimaSala: Sala | null = null;
  private moviendo = false;
  private readonly intentos = new Map<string, { n: number; ultimo: number }>();
  private readonly o: {
    riot: Pick<ResolutorRiot, 'contexto' | 'olvida'>;
    puuidPropio: () => Promise<string>;
    log: (texto: string) => void;
    esperaMs?: number;
    maxIntentos?: number;
    ahora?: () => number;
  };

  constructor(opciones: Colocador['o']) {
    this.o = opciones;
  }

  /** Lo que quiere el panel (se sustituye entero). Una lista vacía apaga la colocación. */
  fija(deseado: Colocacion[]): void {
    const igual = JSON.stringify(deseado) === JSON.stringify(this.deseado);
    this.deseado = deseado;
    if (igual) return;
    this.intentos.clear();
    if (this.ultimaSala !== null) void this.aplica(this.ultimaSala);
  }

  get activo(): boolean {
    return this.deseado.length > 0;
  }

  /** Cada lectura de la sala pasa por aquí. */
  async aplica(sala: Sala | null): Promise<number> {
    this.ultimaSala = sala;
    if (sala === null || this.deseado.length === 0 || this.moviendo || !salaMovible(sala)) return 0;
    const ahora = (this.o.ahora ?? Date.now)();
    const espera = this.o.esperaMs ?? 6000;
    const tope = this.o.maxIntentos ?? 4;

    const propio = await this.o.puuidPropio().catch(() => '');
    const hechos = planDeMovimientos(sala, this.deseado, propio);
    // Quien ya está bien deja de contar intentos.
    for (const d of this.deseado) if (!hechos.some((h) => h.puuid === d.puuid)) this.intentos.delete(d.puuid);

    this.moviendo = true;
    let movidos = 0;
    try {
      for (const mov of hechos) {
        const previo = this.intentos.get(mov.puuid) ?? { n: 0, ultimo: 0 };
        if (previo.n >= tope || (previo.n > 0 && ahora - previo.ultimo < espera)) continue;
        this.intentos.set(mov.puuid, { n: previo.n + 1, ultimo: ahora });
        const r = await mueveJugador(this.o.riot, mov);
        if (r.ok) {
          movidos += 1;
          this.o.log(`sala de Riot: ${mov.puuid.slice(0, 8)}… pasado a ${mov.equipo === 'TeamTwo' ? 'Attackers' : 'Defenders'}`);
        } else {
          this.o.log(`sala de Riot: no se pudo mover a ${mov.puuid.slice(0, 8)}… (${r.error}) [intento ${previo.n + 1}/${tope}]`);
        }
      }
    } finally {
      this.moviendo = false;
    }
    return movidos;
  }
}
