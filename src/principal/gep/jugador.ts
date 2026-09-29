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
import { analiza, habilidades, informeRonda, marcador, marcadorCompanero, marcadorVacio } from './transforma.ts';

const REINTENTO_MS = 1500;

/** GEP manda los booleanos a veces como texto. */
const verdadero = (v: unknown): boolean => v === true || v === 'true';

type Companero = ReturnType<typeof marcadorCompanero>;

export class TraductorJugador {
  soyEspectador = false;
  puuid = '';
  nombre = '';
  matchId = '';
  private modo = '';
  private custom = false;
  private vida: number | undefined;
  private vidaEnviada: number | undefined;
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
        return g ? [{ tipo: 'envia', type: 'aux_abilities', data: habilidades(g), reintentoMs: REINTENTO_MS }] : [];
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
        if (value === 'MainMenu') this.soyEspectador = false;
        return [];
      case 'team':
        if (value === 'observer') this.soyEspectador = true;
        return [];
      case 'observing':
        this.soyEspectador = true;
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
    if (!g || g.name === undefined) return [];
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
  tick(): Accion[] {
    const acciones: Accion[] = [];
    if (this.vida !== undefined && this.vida !== this.vidaEnviada) {
      this.vidaEnviada = this.vida;
      acciones.push({ tipo: 'envia', type: 'aux_health', data: this.vida });
    }
    if (this.companerosCambiados) {
      // El servidor espera aquí una cadena JSON dentro del paquete (§3.3).
      acciones.push({ tipo: 'envia', type: 'aux_scoreboard_team', data: JSON.stringify([...this.companeros.values()]) });
      this.companeros.clear();
      this.companerosCambiados = false;
    }
    return acciones;
  }

  /** Al marcar desconectado: se olvida la vida enviada y el almacén de compañeros. */
  reinicia(): void {
    this.vidaEnviada = undefined;
    this.companeros.clear();
    this.companerosCambiados = false;
  }
}
