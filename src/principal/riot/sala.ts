/**
 * La sala personalizada del cliente de Riot local (beta, zona gris):
 * lectura, forma que ve el panel y sondeo.
 *
 * Sólo ve la sala en la que está ESTE cliente de Riot, y funciona mejor si el
 * observador es el anfitrión.
 */

import type { ContextoRiot, ResolutorRiot } from './contexto.ts';
import { objeto, pide } from './peticion.ts';

export interface JugadorSala {
  puuid: string;
  nombre: string;
  tag: string;
  rango?: number;
  listo: boolean;
  moderador: boolean;
  hudBroadcast: boolean;
}

export interface Sala {
  equipoUno: JugadorSala[];
  equipoDos: JugadorSala[];
  observadores: JugadorSala[];
  coachesUno: JugadorSala[];
  coachesDos: JugadorSala[];
  coaches: JugadorSala[];
  estado: unknown;
  codigo: string;
  mapa: string;
  modo: string;
  servidor: string;
  cerrada: boolean;
}

/** Tabla G: nombre interno del mapa → nombre visible. */
const MAPAS: Record<string, string> = {
  Ascent: 'Ascent',
  Duality: 'Bind',
  Bonsai: 'Split',
  Port: 'Icebox',
  Triad: 'Haven',
  Foxtrot: 'Breeze',
  Canyon: 'Fracture',
  Pitt: 'Pearl',
  Jam: 'Lotus',
  Juliett: 'Sunset',
  Infinity: 'Abyss',
  Rook: 'Corrode',
};

const CIUDADES: Record<string, string> = {
  bogota: 'Bogotá',
  santiago: 'Santiago',
  saopaulo: 'São Paulo',
  miami: 'Miami',
  chicago: 'Chicago',
  mexico: 'México',
  dallas: 'Dallas',
  atlanta: 'Atlanta',
};

export function nombreMapa(ruta: unknown): string {
  if (typeof ruta !== 'string' || ruta === '') return '';
  const ultimo = ruta.split('/').filter(Boolean).pop() ?? '';
  return MAPAS[ultimo] ?? ultimo;
}

export function nombreModo(ruta: unknown): string {
  if (typeof ruta !== 'string' || ruta === '') return '';
  if (ruta.includes('/Bomb/')) return 'Estándar';
  const m = /GameModes\/([^/]+)/.exec(ruta);
  return m?.[1] ?? '';
}

export function ciudadServidor(gamePod: unknown): string {
  if (typeof gamePod !== 'string') return '';
  const m = /-gp-([a-z]+)/i.exec(gamePod);
  if (!m) return '';
  const c = m[1].toLowerCase();
  return CIUDADES[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

const puuidsDe = (lista: unknown): string[] =>
  Array.isArray(lista) ? lista.map((e) => objeto(e).Subject).filter((s): s is string => typeof s === 'string') : [];

/**
 * La sala a partir de la party de Riot, los nombres y los rangos conocidos.
 * `null` si la party no es una partida personalizada.
 */
export function construyeSala(
  party: Record<string, unknown>,
  nombres: Map<string, { nombre: string; tag: string }>,
  rango: (puuid: string) => number | undefined,
): Sala | null {
  const custom = objeto(party.CustomGameData);
  const membresia = objeto(custom.Membership);
  if (Object.keys(membresia).length === 0) return null;

  const miembros = new Map<string, Record<string, unknown>>();
  if (Array.isArray(party.Members)) {
    for (const m of party.Members) {
      const o = objeto(m);
      if (typeof o.Subject === 'string') miembros.set(o.Subject, o);
    }
  }

  const jugador = (puuid: string): JugadorSala => {
    const m = miembros.get(puuid) ?? {};
    const n = nombres.get(puuid);
    const j: JugadorSala = {
      puuid,
      nombre: n?.nombre ?? '…',
      tag: n?.tag ?? '',
      listo: m.IsReady === true,
      moderador: m.IsModerator === true,
      hudBroadcast: m.UseBroadcastHUD === true,
    };
    const r = rango(puuid);
    if (r !== undefined) j.rango = r;
    return j;
  };

  const grupo = (clave: string) => puuidsDe(membresia[clave]).map(jugador);
  const coachesUno = grupo('teamOneCoaches');
  const coachesDos = grupo('teamTwoCoaches');
  const ajustes = objeto(custom.Settings);

  return {
    equipoUno: grupo('teamOne'),
    equipoDos: grupo('teamTwo'),
    observadores: grupo('teamSpectate'),
    coachesUno,
    coachesDos,
    coaches: [...coachesUno, ...coachesDos],
    estado: party.State,
    codigo: typeof party.InviteCode === 'string' ? party.InviteCode : '',
    mapa: nombreMapa(ajustes.Map),
    modo: nombreModo(ajustes.Mode),
    servidor: ciudadServidor(ajustes.GamePod),
    cerrada: party.Accessibility === 'CLOSED',
  };
}

/** Todos los puuids de la membresía, para pedir sus nombres. */
export function puuidsDeSala(party: Record<string, unknown>): string[] {
  const membresia = objeto(objeto(party.CustomGameData).Membership);
  return ['teamOne', 'teamTwo', 'teamSpectate', 'teamOneCoaches', 'teamTwoCoaches'].flatMap((k) => puuidsDe(membresia[k]));
}

/* ── Lectura ──────────────────────────────────────────────────────────────── */

export async function leeParty(c: ContextoRiot): Promise<{ id: string; party: Record<string, unknown> } | null> {
  if (c.glz === '') return null;
  const jugador = await pide(`${c.glz}/parties/v1/players/${c.puuid}`, { cabeceras: c.cabeceras });
  const id = objeto(jugador.json()).CurrentPartyID;
  if (typeof id !== 'string' || id === '') return null;
  const r = await pide(`${c.glz}/parties/v1/parties/${id}`, { cabeceras: c.cabeceras });
  if (r.estado !== 200) return null;
  return { id, party: objeto(r.json()) };
}

async function leeNombres(c: ContextoRiot, puuids: string[]): Promise<Map<string, { nombre: string; tag: string }>> {
  const nombres = new Map<string, { nombre: string; tag: string }>();
  if (puuids.length === 0 || c.pd === '') return nombres;
  try {
    const r = await pide(`${c.pd}/name-service/v2/players`, { metodo: 'PUT', cabeceras: c.cabeceras, cuerpo: puuids });
    const lista = r.json();
    if (Array.isArray(lista)) {
      for (const e of lista) {
        const o = objeto(e);
        if (typeof o.Subject === 'string') {
          nombres.set(o.Subject, { nombre: String(o.GameName ?? '…'), tag: String(o.TagLine ?? '') });
        }
      }
    }
  } catch {
    // Sin nombres: salen como "…" y se reintentan en la siguiente lectura.
  }
  return nombres;
}

export interface OpcionesLector {
  riot: ResolutorRiot;
  rango: (puuid: string) => number | undefined;
  /** Los rangos que falten se piden en segundo plano; entrarán en la siguiente lectura. */
  pideRango: (puuid: string) => void;
  entrega: (sala: Sala | null) => void;
  log: (texto: string) => void;
}

export async function leeSala(o: Pick<OpcionesLector, 'riot' | 'rango' | 'pideRango'>): Promise<Sala | null> {
  const c = await o.riot.contexto();
  if (c === null) return null;
  const p = await leeParty(c);
  if (p === null) return null;
  const puuids = puuidsDeSala(p.party);
  if (puuids.length === 0) return construyeSala(p.party, new Map(), o.rango);
  const nombres = await leeNombres(c, puuids);
  for (const puuid of puuids) if (o.rango(puuid) === undefined) o.pideRango(puuid);
  return construyeSala(p.party, nombres, o.rango);
}

/**
 * Sondeo: entrega una lectura si cambió (incluido el paso a `null`) o si han
 * pasado ~30 s desde la última (latido, para que reaparezca tras reiniciar el
 * servidor). Arrancar con el lector activo no hace nada.
 */
export class LectorSala {
  private reloj: NodeJS.Timeout | null = null;
  private ultima: string | undefined;
  private ultimaEntrega = 0;
  private leyendo = false;
  private readonly o: OpcionesLector;

  constructor(opciones: OpcionesLector) {
    this.o = opciones;
  }

  get activo(): boolean {
    return this.reloj !== null;
  }

  arranca(periodoMs = 3000): void {
    if (this.reloj !== null) return;
    this.ultima = undefined;
    this.reloj = setInterval(() => void this.vuelta(), periodoMs);
    void this.vuelta();
    this.o.log(`lector de sala en marcha (cada ${periodoMs} ms)`);
  }

  para(): void {
    if (this.reloj === null) return;
    clearInterval(this.reloj);
    this.reloj = null;
    this.o.log('lector de sala parado');
  }

  private async vuelta(): Promise<void> {
    if (this.leyendo) return;
    this.leyendo = true;
    try {
      const sala = await leeSala(this.o).catch((e: unknown) => {
        this.o.log(`lector de sala: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (this.reloj === null) return;
      const serie = JSON.stringify(sala);
      if (serie !== this.ultima || Date.now() - this.ultimaEntrega > 30_000) {
        this.ultima = serie;
        this.ultimaEntrega = Date.now();
        this.o.entrega(sala);
      }
    } finally {
      this.leyendo = false;
    }
  }
}
