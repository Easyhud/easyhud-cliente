/**
 * Traductor de GEP del observador: dato de GEP → acciones.
 *
 * Lleva el poco estado que hace falta entre datos (ronda, fase, escena, último
 * marcador de rondas, caché de roster del mapa…) y nada más. No envía nada: lo
 * que hay que mandar al servidor, al panel o al socket lo devuelve como
 * acciones (ver `acciones.ts`).
 *
 * Reglas:
 *   · en `game_end` el estado de juego queda en "Game Ended";
 *   · el `map` del fin de mapa es el último código de mapa de GEP, no la escena;
 *   · `team` del roster del fin de mapa acepta `startTeam` numérico o texto;
 *   · al volver al menú se vacían la caché de roster y el marcador de rondas;
 *   · `map`, `game_mode` y `match_start` se recuerdan y se reenvían al
 *     autenticar.
 */

import type { Accion, DatoGep, FinDeMapa } from './acciones.ts';
import {
  analiza,
  codigoMapa,
  killfeed,
  marcador,
  marcadorVacio,
  roster,
  type Marcador,
} from './transforma.ts';

/** Claves que GEP manda y que el observador no usa. */
const IGNORADAS = new Set([
  'player_id',
  'state',
  'score',
  'agent',
  'match_outcome',
  'pseudo_match_id',
  'region',
  'planted_site',
  'is_pbe',
  'ui_team_order_allies',
  'ui_team_order_enemies',
]);

const EVENTOS_IGNORADOS = new Set(['scoreboard_screen', 'kill_feed', 'shop', 'planted_location']);

export interface OpcionesObservador {
  /** Rango ya conocido de un puuid (caché de §2.6), o `undefined`. */
  rangoEnCache?: (puuid: string) => number | undefined;
}

export class TraductorObservador {
  private ronda = 0;
  private fase = '';
  private escena = '';
  private mapa = '';
  private modo = '';
  private custom = false;
  private matchId = '';
  private partidaEnCurso = false;
  private marcadorRondas: { team_0: number; team_1: number } | null = null;
  private readonly cacheRoster = new Map<string, Marcador>();
  /** "Es observador": GEP dice que el cliente local está mirando, no jugando. */
  esObservador = false;
  private readonly rangoEnCache: (puuid: string) => number | undefined;

  constructor(opciones: OpcionesObservador = {}) {
    this.rangoEnCache = opciones.rangoEnCache ?? (() => undefined);
  }

  /** La última fase de ronda vista (para la tecla de spike). */
  get faseActual(): string {
    return this.fase;
  }

  get modoDeJuego(): { modo: string; custom: boolean } {
    return { modo: this.modo, custom: this.custom };
  }

  /** Lo que conviene repetir al servidor al (re)autenticar. */
  alAutenticar(): Accion[] {
    const acciones: Accion[] = [];
    if (this.mapa !== '') acciones.push({ tipo: 'envia', type: 'map', data: this.mapa });
    if (this.modo !== '') acciones.push({ tipo: 'envia', type: 'game_mode', data: this.modo });
    if (this.partidaEnCurso && this.matchId !== '') {
      acciones.push({ tipo: 'envia', type: 'match_start', data: this.matchId });
    }
    return acciones;
  }

  /* ── Actualizaciones de información (§2.2) ─────────────────────────────── */

  info({ key, value }: DatoGep): Accion[] {
    if (key.includes('scoreboard')) return this.marcador(value);
    if (key.includes('roster')) return this.roster(key, value);

    switch (key) {
      case 'kill_feed': {
        const g = analiza(value);
        return g ? [{ tipo: 'envia', type: 'killfeed', data: killfeed(g) }] : [];
      }
      case 'observing':
        if (value === null || value === undefined) return [];
        this.esObservador = true;
        return [{ tipo: 'envia', type: 'observing', data: value }];
      case 'round_number': {
        const n = Number(value);
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(n)) this.ronda = n;
        return [];
      }
      case 'round_phase':
        return this.faseDeRonda(value);
      case 'match_score': {
        const g = analiza(value);
        if (!g) return [];
        this.marcadorRondas = { team_0: Number(g.team_0) || 0, team_1: Number(g.team_1) || 0 };
        return [{ tipo: 'envia', type: 'score', data: g }];
      }
      case 'team':
        if (value === 'observer') this.esObservador = true;
        return [];
      case 'scene':
        return this.cambiaEscena(value);
      case 'game_mode': {
        const g = analiza(value);
        if (!g || g.mode === undefined || g.mode === null) return [];
        this.modo = String(g.mode);
        this.custom = g.custom === true || g.custom === 'true';
        return [{ tipo: 'envia', type: 'game_mode', data: this.modo }];
      }
      case 'map':
        if (value === null || value === undefined || value === '') return [];
        this.mapa = codigoMapa(String(value));
        return [{ tipo: 'envia', type: 'map', data: this.mapa }];
      case 'match_id':
        if (value === null || value === undefined) return [];
        this.matchId = String(value);
        return [];
      case 'player_name':
        return [];
      case 'health':
      case 'abilities':
        return [{ tipo: 'log', texto: `${key} recibido en modo observador` }];
      default:
        if (IGNORADAS.has(key)) return [];
        return [{ tipo: 'log', texto: `Unhandled info update: ${key}` }];
    }
  }

  private marcador(value: unknown): Accion[] {
    if (marcadorVacio(value)) return [];
    const g = analiza(value);
    if (!g || g.name === undefined) return [];
    const m = marcador(g);
    if (typeof m.playerId === 'string' && m.playerId !== '') this.cacheRoster.set(m.playerId, m);
    return [{ tipo: 'envia', type: 'scoreboard', data: m }];
  }

  private roster(key: string, value: unknown): Accion[] {
    const g = analiza(value);
    if (!g || g.name === undefined) return [];
    const r = roster(g, key);
    const puuid = typeof r.playerId === 'string' ? r.playerId : '';
    const enCache = puuid !== '' ? this.rangoEnCache(puuid) : undefined;
    if (enCache !== undefined) {
      r.rank = enCache;
      return [{ tipo: 'envia', type: 'roster', data: r }];
    }
    const acciones: Accion[] = [{ tipo: 'envia', type: 'roster', data: r }];
    if (puuid !== '') acciones.push({ tipo: 'resuelveRango', roster: r });
    return acciones;
  }

  private faseDeRonda(value: unknown): Accion[] {
    if (value === null || value === undefined) return [];
    const fase = String(value);
    this.fase = fase;
    const acciones: Accion[] = [
      { tipo: 'envia', type: 'round_info', data: { roundNumber: this.ronda, roundPhase: fase } },
      { tipo: 'fase', fase },
    ];
    if (fase === 'game_end') {
      acciones.push(...this.finDeMapa());
      return acciones;
    }
    acciones.push({ tipo: 'estadoJuego', mensaje: `Round ${this.ronda}`, clase: 'success' });
    return acciones;
  }

  private cambiaEscena(value: unknown): Accion[] {
    if (value === null || value === undefined) return [];
    this.escena = String(value);
    switch (this.escena) {
      case 'CharacterSelectPersistentLevel':
        return [{ tipo: 'conecta' }, { tipo: 'estadoJuego', mensaje: 'Agent Select', clase: 'success' }];
      case 'MainMenu':
        this.esObservador = false;
        this.partidaEnCurso = false;
        // Una partida abandonada no debe dejar jugadores ni marcador para la siguiente.
        this.cacheRoster.clear();
        this.marcadorRondas = null;
        return [{ tipo: 'estadoJuego', mensaje: 'Main Menu', clase: 'info' }];
      case 'Range':
        return [{ tipo: 'estadoJuego', mensaje: 'Practice Range', clase: 'info' }];
      default:
        return [];
    }
  }

  /* ── Fin de mapa (§2.5) ────────────────────────────────────────────────── */

  private finDeMapa(): Accion[] {
    const izq = this.marcadorRondas?.team_0 ?? 0;
    const der = this.marcadorRondas?.team_1 ?? 0;
    const acciones: Accion[] = [{ tipo: 'log', texto: `fin de mapa: ${izq}-${der} (${this.mapa || this.escena || '?'})` }];
    if (izq !== der) {
      const datos: FinDeMapa = {
        ganador: izq > der ? 0 : 1,
        izq,
        der,
        map: this.mapa || this.escena || '',
        matchId: this.matchId,
        roster: [...this.cacheRoster.values()].map((m) => ({
          name: m.name,
          tagline: m.tagline,
          team: Number(m.startTeam) === 1 ? 1 : 0,
          agentInternal: m.agentInternal,
          kills: m.kills,
          deaths: m.deaths,
          assists: m.assists,
        })),
      };
      acciones.push({ tipo: 'finMapa', datos });
    } else {
      acciones.push({ tipo: 'log', texto: 'fin de mapa en empate: no se notifica al panel' });
    }
    this.cacheRoster.clear();
    this.marcadorRondas = null;
    this.esObservador = false;
    this.partidaEnCurso = false;
    acciones.push({ tipo: 'estadoJuego', mensaje: 'Game Ended', clase: 'info' }, { tipo: 'finConexion' });
    return acciones;
  }

  /* ── Eventos de juego (§2.3) ───────────────────────────────────────────── */

  evento({ key }: DatoGep): Accion[] {
    switch (key) {
      case 'match_start':
        this.partidaEnCurso = true;
        return [
          { tipo: 'envia', type: 'match_start', data: this.matchId },
          { tipo: 'estadoJuego', mensaje: 'Game Started', clase: 'success' },
          { tipo: 'persisteSecreto' },
        ];
      case 'spike_planted':
      case 'spike_detonated':
      case 'spike_defused':
        return [{ tipo: 'envia', type: key, data: true }];
      case 'match_end':
        this.partidaEnCurso = false;
        return [{ tipo: 'estadoJuego', mensaje: 'Game Ended', clase: 'info' }, { tipo: 'finConexion' }];
      default:
        if (EVENTOS_IGNORADOS.has(key)) return [];
        return [{ tipo: 'log', texto: `Unhandled game event: ${key}` }];
    }
  }
}
