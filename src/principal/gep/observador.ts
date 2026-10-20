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
 *     autenticar, pero sólo los de la partida actual: al acabar la partida (fin
 *     de mapa) o volver al menú se olvidan, para que la reconexión automática de
 *     después no reenvíe el mapa y el modo de la que ya terminó;
 *   · el filtro de «estado viejo» (ver `esEstadoViejo`) sólo vale para la ráfaga
 *     inicial tras detectar el juego.
 */

import type { Accion, DatoGep, FinDeMapa } from './acciones.ts';
import {
  analiza,
  codigoMapa,
  killfeed,
  marcador,
  marcadorVacio,
  roster,
  sinNombre,
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

/** Cada cuánto se resume en el log qué marcadores entrega Overwolf. */
const INFORME_MARCADORES_MS = 30_000;

const EVENTOS_IGNORADOS = new Set(['scoreboard_screen', 'kill_feed', 'shop', 'planted_location']);

/** Duración de la ráfaga con la que Overwolf repite el último estado al detectar el juego. */
const RAFAGA_VIEJA_MS = 3000;
/**
 * Un `match_start` dentro de este margen desde el inicio de la ráfaga es parte de lo repetido (llega pegado
 * al resto); pasado el margen es el de una partida de verdad.
 */
const MARGEN_MATCH_START_MS = 1000;

export interface OpcionesObservador {
  /** Reloj en ms (las pruebas lo controlan). */
  ahora?: () => number;
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
  /** Diagnóstico: qué marcadores entrega Overwolf (por clave `scoreboard_N`) y cuántos vienen vacíos. */
  private readonly marcadoresVistos = new Map<string, { nombre: string; n: number; vacios: number }>();
  private readonly clavesAnotadas = new Set<string>();
  private ultimoInformeMarcadores = 0;
  /** "Es observador": GEP dice que el cliente local está mirando, no jugando. */
  esObservador = false;
  private readonly rangoEnCache: (puuid: string) => number | undefined;
  private readonly ahora: () => number;
  /** ¿Sigue vigente el filtro de estado viejo? Se desactiva para siempre (hasta detectar el juego otra vez). */
  private filtroViejoActivo = true;
  /** Cuándo empezó la ráfaga: al detectar el juego o, si no se avisó, con el primer dato. */
  private inicioRafaga: number | null = null;
  /** La última fase de ronda que se ignoró por vieja: una distinta es una señal viva. */
  private faseVieja: string | null = null;

  constructor(opciones: OpcionesObservador = {}) {
    this.rangoEnCache = opciones.rangoEnCache ?? (() => undefined);
    this.ahora = opciones.ahora ?? Date.now;
  }

  /** Overwolf detectó VALORANT: empieza (otra vez) la ráfaga en la que se ignora el estado viejo. */
  juegoDetectado(): void {
    this.filtroViejoActivo = true;
    this.inicioRafaga = this.ahora();
    this.faseVieja = null;
    this.viejosAnotados.clear();
  }

  /** VALORANT se cerró: el siguiente dato (o la próxima detección) abre una ráfaga nueva. */
  juegoCerrado(): void {
    this.filtroViejoActivo = true;
    this.inicioRafaga = null;
    this.faseVieja = null;
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

  /**
   * Al detectar VALORANT, Overwolf REPITE el último estado de la partida anterior (ronda, marcador, roster,
   * «match_start»…), y lo hace DESPUÉS de decir que la escena actual es el menú. Con el programa estando en
   * el menú y sin haber visto ninguna partida suya, eso es del pasado: hacerle caso dejaba el panel en
   * «IN GAME · R2» y mandaba al servidor jugadores y marcadores fantasma de una partida que ya no existe.
   */
  private esEstadoViejo(): boolean {
    return this.filtroViejoActivo && this.escena === 'MainMenu' && !this.partidaEnCurso && this.marcadorRondas === null;
  }

  /**
   * El filtro sólo vale para la ráfaga inicial (`RAFAGA_VIEJA_MS` tras detectar el juego). Si Overwolf no
   * actualiza la escena, una partida real entera caería en él y se ignoraría: por eso se desactiva al pasar
   * el tiempo o en cuanto llega una señal viva (escena que no es el menú, `match_start` fuera de la ráfaga,
   * o una fase de ronda distinta de la repetida). Devuelve la línea de log del momento en que se desactiva.
   */
  private revisaFiltro(tipo: 'info' | 'evento', { key, value }: DatoGep): Accion[] {
    if (!this.filtroViejoActivo) return [];
    const t = this.ahora();
    this.inicioRafaga ??= t;
    const desde = t - this.inicioRafaga;
    let motivo = '';
    if (desde >= RAFAGA_VIEJA_MS) motivo = `pasaron ${RAFAGA_VIEJA_MS / 1000} s desde que se detectó el juego`;
    else if (tipo === 'info' && key === 'scene' && value !== null && value !== undefined && String(value) !== 'MainMenu') {
      motivo = `cambio de escena a ${String(value)}`;
    } else if (tipo === 'evento' && key === 'match_start' && desde >= MARGEN_MATCH_START_MS) motivo = 'match_start';
    else if (tipo === 'info' && key === 'round_phase' && value !== null && value !== undefined && this.faseVieja !== null && String(value) !== this.faseVieja) {
      motivo = `fase de ronda nueva (${String(value)})`;
    }
    if (motivo === '') return [];
    this.filtroViejoActivo = false;
    return [{ tipo: 'log', texto: `filtro de estado viejo desactivado: ${motivo}` }];
  }

  private readonly viejosAnotados = new Set<string>();
  private ignoraViejo(key: string): Accion[] {
    if (this.viejosAnotados.has(key)) return [];
    this.viejosAnotados.add(key);
    return [{ tipo: 'log', texto: `estado de la partida anterior ignorado (el juego está en el menú): ${key}` }];
  }

  info(dato: DatoGep): Accion[] {
    const aviso = this.revisaFiltro('info', dato);
    const acciones = this.infoFiltrada(dato);
    return aviso.length > 0 ? [...aviso, ...acciones] : acciones;
  }

  private infoFiltrada({ key, value }: DatoGep): Accion[] {
    if (
      this.esEstadoViejo() &&
      (key === 'round_phase' || key === 'round_number' || key === 'match_score' || key.includes('scoreboard') || key.includes('roster'))
    ) {
      if (key === 'round_phase' && value !== null && value !== undefined) this.faseVieja = String(value);
      return this.ignoraViejo(key.replace(/_\d+$/, '_N'));
    }
    if (key.includes('scoreboard')) return [...this.cuentaMarcador(key, value), ...this.marcador(value)];
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

  /**
   * Diagnóstico: apunta cada evento de marcador que entrega Overwolf y, cada `INFORME_MARCADORES_MS`,
   * escribe en el log cuántos llegó de cada jugador y cuántos vacíos. Sirve para ver si Overwolf deja
   * de mandar el marcador de alguien (o lo manda sin nombre y se descarta). La primera vez que sale
   * una clave se anota. No cambia nada de lo que se envía.
   */
  private cuentaMarcador(key: string, value: unknown, ahora = Date.now()): Accion[] {
    const acciones: Accion[] = [];
    const vacio = marcadorVacio(value);
    const g = vacio ? null : analiza(value);
    const nombre = g && typeof g.name === 'string' ? g.name : '';
    const ficha = this.marcadoresVistos.get(key) ?? { nombre: '', n: 0, vacios: 0 };
    if (!this.clavesAnotadas.has(key)) {
      this.clavesAnotadas.add(key);
      acciones.push({ tipo: 'log', texto: `marcador GEP: primera vez que llega ${key} (${vacio ? 'vacío' : nombre || 'sin nombre'})` });
    }
    if (nombre !== '') ficha.nombre = nombre;
    if (vacio || nombre === '') ficha.vacios += 1;
    else ficha.n += 1;
    this.marcadoresVistos.set(key, ficha);

    if (this.ultimoInformeMarcadores === 0) this.ultimoInformeMarcadores = ahora;
    if (ahora - this.ultimoInformeMarcadores >= INFORME_MARCADORES_MS) {
      this.ultimoInformeMarcadores = ahora;
      const partes = [...this.marcadoresVistos.entries()]
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([k, f]) => `${k} ${f.nombre || '?'}: ${f.n}${f.vacios > 0 ? ` (+${f.vacios} vacíos)` : ''}`);
      acciones.push({ tipo: 'log', texto: `marcador GEP, últimos ${INFORME_MARCADORES_MS / 1000} s → ${partes.join(' · ')}` });
      this.marcadoresVistos.clear();
    }
    return acciones;
  }

  private marcador(value: unknown): Accion[] {
    if (marcadorVacio(value)) return [];
    const g = analiza(value);
    if (!g || sinNombre(g.name)) return [];
    const m = marcador(g);
    if (typeof m.playerId === 'string' && m.playerId !== '') this.cacheRoster.set(m.playerId, m);
    return [{ tipo: 'envia', type: 'scoreboard', data: m }];
  }

  private roster(key: string, value: unknown): Accion[] {
    const g = analiza(value);
    if (!g || sinNombre(g.name)) return [];
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
        this.viejosAnotados.clear();
        this.esObservador = false;
        this.partidaEnCurso = false;
        this.olvidaPartida();
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

  /** Se olvida lo que `alAutenticar` reenviaría de la partida que acaba de terminar. */
  private olvidaPartida(): void {
    this.mapa = '';
    this.modo = '';
    this.custom = false;
    this.matchId = '';
    this.partidaEnCurso = false;
  }

  /* ── Fin de mapa (§2.5) ────────────────────────────────────────────────── */

  private finDeMapa(): Accion[] {
    /* Un «fin de mapa» sin que este programa haya visto nada de la partida (ni un marcador de rondas ni
       el inicio de la partida) es el último estado que Overwolf RELEE al arrancar el programa con la
       partida anterior ya terminada, no una partida que acabe ahora. Hacerle caso cerraba la conexión
       con el servidor y destruía el partido nuevo recién creado: el panel se quedaba sin observador. */
    if (this.marcadorRondas === null && !this.partidaEnCurso) {
      return [{ tipo: 'log', texto: 'fin de mapa ignorado: es el estado de una partida anterior, releído al arrancar' }];
    }
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
    // Ya se usaron mapa y matchId en `datos`: la partida terminó y no debe reenviarse al reautenticar.
    this.olvidaPartida();
    acciones.push({ tipo: 'estadoJuego', mensaje: 'Game Ended', clase: 'info' }, { tipo: 'finConexion' });
    return acciones;
  }

  /* ── Eventos de juego (§2.3) ───────────────────────────────────────────── */

  evento(dato: DatoGep): Accion[] {
    const aviso = this.revisaFiltro('evento', dato);
    const acciones = this.eventoFiltrado(dato);
    return aviso.length > 0 ? [...aviso, ...acciones] : acciones;
  }

  private eventoFiltrado({ key }: DatoGep): Accion[] {
    if ((key === 'match_start' || key === 'match_end') && this.esEstadoViejo()) return this.ignoraViejo(key);
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
