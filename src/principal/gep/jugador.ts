/**
 * Traductor de GEP del jugador ("auxiliar"): dato de GEP â†’ acciones.
 *
 * En el jugador, info y eventos entran por el mismo sitio (§2.4). Además lleva
 * lo que el bucle de 300 ms tiene que mandar: la vida y el marcador de los
 * compañeros (`tick()`).
 *
 * "Soy espectador": el jugador está en la partida como observador. Mientras lo
 * es, no manda su vida ni sus habilidades (no son suyas), pero sí reenvía
 * cualquier marcador como `aux_scoreboard`.
 *
 * El puuid que llega por el marcador local también se persiste, además del
 * de `player_id`: así un jugador nuevo no aparece como "No app" hasta su
 * primera partida completa.
 */

import type { Accion, DatoGep } from './acciones.ts';
import { analiza, habilidades, informeRonda, marcador, marcadorCompanero, marcadorVacio, sinNombre } from './transforma.ts';

const REINTENTO_MS = 1500;
/** Cada cuánto se repiten la vida y las habilidades aunque no cambien: si el servidor pierde la marca de «este jugador manda su vida» (pausa técnica, mapa nuevo, reconexión), se recupera sola. */
const REPITE_MS = 4000;

/** GEP manda los booleanos a veces como texto. */
const verdadero = (v: unknown): boolean => v === true || v === 'true';

type Companero = ReturnType<typeof marcadorCompanero>;

export class TraductorJugador {
  /**
   * «Soy espectador»: no se manda vida ni habilidades. Sólo lo marcan las señales de GEP que llegan ESTANDO
   * en una partida (`team: observer`, `observing`). Con la escena en el menú NO se les hace caso: al detectar
   * VALORANT, Overwolf repite el último estado de la partida anterior (también su `observing`, p. ej. de
   * cuando murió y miró a un compañero), y hacerle caso dejaba al jugador marcado como espectador toda la
   * partida nueva: sin un solo dato de vida ni de habilidades.
   */
  soyEspectador = false;
  /** La escena actual de GEP (`MainMenu`, la selección de agentes, el mapa…). */
  private escena = '';

  /** GEP dice que estamos en el menú (o aún no ha dicho nada): ahí no hay datos de partida que valgan. */
  get enMenu(): boolean {
    return this.escena === '' || this.escena === 'MainMenu';
  }
  puuid = '';
  nombre = '';
  matchId = '';
  private modo = '';
  private custom = false;
  private vida: number | undefined;
  private vidaEnviada: number | undefined;
  /** Lo último que se mandó de habilidades y cuándo se repitió cada cosa (para repetirlo cada pocos segundos). */
  private ultimasHabilidades: ReturnType<typeof habilidades> | undefined;
  private repetidoEn = 0;
  private readonly companeros = new Map<string, Companero>();
  private companerosCambiados = false;

  constructor(puuidGuardado = '') {
    this.puuid = puuidGuardado;
  }

  /** Partida en la que tiene sentido conectarse: estándar o swift, y personalizada. */
  private enCustomValida(): boolean {
    return (this.modo === 'bomb' || this.modo === 'swift') && this.custom;
  }

  procesa({ key, value }: DatoGep): Accion[] {
    if (key.includes('scoreboard')) return this.marcador(value);

    switch (key) {
      case 'health': {
        if (this.soyEspectador || value === null || value === undefined || value === '') return [];
        const n = Number(value);
        if (Number.isFinite(n)) this.vida = n;
        return [];
      }
      case 'abilities': {
        if (this.soyEspectador) return [];
        const g = analiza(value);
        if (!g) return [];
        this.ultimasHabilidades = habilidades(g);
        return [{ tipo: 'envia', type: 'aux_abilities', data: this.ultimasHabilidades, reintentoMs: REINTENTO_MS }];
      }
      case 'round_report': {
        if (this.soyEspectador) return [];
        const g = analiza(value);
        return g ? [{ tipo: 'envia', type: 'aux_round_report', data: informeRonda(g), reintentoMs: REINTENTO_MS }] : [];
      }
      case 'round_phase':
        if (value === 'end') return this.enCustomValida() ? [{ tipo: 'conecta' }] : [];
        if (value === 'game_end') {
          this.soyEspectador = false;
          const acciones: Accion[] = [];
          if (this.puuid !== '') acciones.push({ tipo: 'persistePuuid', puuid: this.puuid });
          acciones.push({ tipo: 'estadoJuego', mensaje: 'Game Ended', clase: 'info' }, { tipo: 'finConexion' });
          return acciones;
        }
        return [];
      case 'agent': {
        if (this.soyEspectador || value === null || value === undefined) return [];
        const texto = String(value);
        if (texto.includes('Rift')) return [{ tipo: 'envia', type: 'aux_astra_targeting', data: texto.includes('Targeting') }];
        if (texto.includes('Gumshoe')) {
          return [{ tipo: 'envia', type: 'aux_cypher_cam', data: texto.includes('PossessableCamera') }];
        }
        return [];
      }
      case 'match_start':
        // Un segundo de margen para que el observador mande antes el matchId.
        return this.enCustomValida() ? [{ tipo: 'conecta', retardoMs: 1000 }] : [];
      case 'game_mode': {
        const g = analiza(value);
        if (g && g.mode !== undefined && g.mode !== null) {
          this.modo = String(g.mode);
          this.custom = verdadero(g.custom);
        }
        return [];
      }
      case 'scene':
        if (value !== null && value !== undefined) this.escena = String(value);
        // Cada escena nueva (menú, selección, mapa) empieza sin la marca: si de verdad es espectador, GEP lo repite DENTRO de la partida.
        this.soyEspectador = false;
        return [];
      case 'team':
        if (value === 'observer' && this.escena !== 'MainMenu') this.soyEspectador = true;
        return [];
      case 'observing':
        if (this.escena !== 'MainMenu') this.soyEspectador = true;
        return [];
      case 'player_id':
        if (typeof value !== 'string' || value === '') return [];
        this.puuid = value;
        return [{ tipo: 'persistePuuid', puuid: value }];
      case 'match_id':
        if (value !== null && value !== undefined) this.matchId = String(value);
        return [];
      case 'player_name':
        if (value !== null && value !== undefined) this.nombre = String(value);
        return [];
      default:
        return [];
    }
  }

  private marcador(value: unknown): Accion[] {
    if (marcadorVacio(value)) return [];
    const g = analiza(value);
    if (!g || sinNombre(g.name)) return [];
    if (verdadero(g.is_local)) {
      const m = marcador(g);
      const acciones: Accion[] = [];
      if (typeof m.playerId === 'string' && m.playerId !== '' && m.playerId !== this.puuid) {
        this.puuid = m.playerId;
        acciones.push({ tipo: 'persistePuuid', puuid: m.playerId });
      }
      acciones.push({ tipo: 'envia', type: 'aux_scoreboard', data: m });
      return acciones;
    }
    if (this.soyEspectador) return [{ tipo: 'envia', type: 'aux_scoreboard', data: marcador(g) }];
    if (verdadero(g.teammate)) {
      const c = marcadorCompanero(g);
      if (typeof c.playerId === 'string' && c.playerId !== '') {
        this.companeros.set(c.playerId, c);
        this.companerosCambiados = true;
      }
    }
    return [];
  }

  /** Lo que toca mandar en esta vuelta del bucle de 300 ms. */
  tick(ahora: number = Date.now()): Accion[] {
    const acciones: Accion[] = [];
    const repite = !this.soyEspectador && ahora - this.repetidoEn >= REPITE_MS;
    if (this.vida !== undefined && (this.vida !== this.vidaEnviada || repite)) {
      this.vidaEnviada = this.vida;
      acciones.push({ tipo: 'envia', type: 'aux_health', data: this.vida });
    }
    if (repite) {
      this.repetidoEn = ahora;
      if (this.ultimasHabilidades !== undefined) acciones.push({ tipo: 'envia', type: 'aux_abilities', data: this.ultimasHabilidades });
    }
    if (this.companerosCambiados) {
      // El servidor espera aquí una cadena JSON dentro del paquete (§3.3).
      acciones.push({ tipo: 'envia', type: 'aux_scoreboard_team', data: JSON.stringify([...this.companeros.values()]) });
      this.companeros.clear();
      this.companerosCambiados = false;
    }
    return acciones;
  }

  /**
   * VALORANT se cerró: se olvida todo lo de la partida (espectador, vida, compañeros), para que al abrirlo
   * de nuevo el jugador empiece limpio y no arrastre el estado de antes.
   */
  reiniciaJuego(): void {
    this.soyEspectador = false;
    this.escena = '';
    this.vida = undefined;
    this.vidaEnviada = undefined;
    this.ultimasHabilidades = undefined;
    this.matchId = '';
    this.companeros.clear();
    this.companerosCambiados = false;
  }

  /** Al marcar desconectado: se olvida la vida enviada y el almacén de compañeros. */
  reinicia(): void {
    this.vidaEnviada = undefined;
    this.companeros.clear();
    this.companerosCambiados = false;
  }
}
