/**
 * El socket de datos contra la ingesta (puerto 5100).
 *
 * Uno solo a la vez, con uno de tres papeles:
 *   · observador            (`obs_logon`, luego `obs_data`/`obs_lobby`/`llamar_jugadores`)
 *   · jugador por matchId   (`aux_logon` con matchId, luego `aux_data`)
 *   · jugador por grupo     (`aux_logon` con groupCode, tras `te_llaman`)
 *
 * Lo que cambia respecto al cliente anterior, y es el motivo de este módulo:
 *
 *   1. El logon se repite en CADA evento `connect` del socket (el inicial y
 *      los de las reconexiones automáticas de socket.io). El servidor ve cada
 *      reconexión como un socket nuevo sin autenticar; antes el cliente no
 *      repetía el logon y seguía creyéndose conectado mientras el servidor
 *      tiraba sus datos. Hasta que llega el acuse no se da por conectado.
 *   2. Se escuchan los eventos que socket.io 4 emite de verdad: en el socket
 *      `connect`, `disconnect` y `connect_error`; en el gestor (`socket.io`)
 *      `reconnect_attempt` y `reconnect`.
 *   3. Al abrir uno nuevo se cierra el anterior esté como esté (conectado o
 *      reintentando): no quedan sockets fantasma con oyentes duplicados.
 *   4. Un logon sin acuse en `esperaAckMs` se da por fallido y se reintenta.
 *
 * No sabe nada de Electron: avisa por la interfaz `Avisos` y quien lo usa
 * decide si eso es un diálogo, el título de la ventana o una línea de log.
 */

import { inspect } from 'node:util';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { ClaseEstado } from '../gep/acciones.ts';
import { leeCarga, logonJugador, logonObservador, motivoAmable, nombreDelToken } from './mensajes.ts';

export type Intencion =
  | { rol: 'observador'; token: string; grupo: string }
  | { rol: 'jugador'; nombre: string; puuid: string; matchId: string }
  | { rol: 'jugador'; nombre: string; puuid: string; grupo: string };

export interface InfoAutenticado {
  rol: 'observador' | 'jugador';
  /** `reconnected` si el servidor reconoció el secreto de reconexión. */
  reason?: string;
  /** Sólo en el observador: el secreto nuevo (el `reason` del acuse). */
  secreto?: string;
  porGrupo: boolean;
}

export interface Avisos {
  estado(mensaje: string, clase: ClaseEstado): void;
  dialogo(titulo: string, mensaje: string, tipo: 'warning' | 'error'): void;
  autenticado(info: InfoAutenticado): void;
  /** "Marcar desconectado": atajos fuera, bucle del jugador parado, etc. */
  desconectado(): void;
  log(texto: string): void;
}

export interface OpcionesEnlace {
  version: string;
  avisos: Avisos;
  /** Secreto de reconexión vigente (se consulta en cada logon). */
  secreto?: () => string;
  esperaAckMs?: number;
  /** Opciones extra del socket (las pruebas acortan tiempos). */
  opcionesSocket?: Partial<ManagerOptions & SocketOptions>;
}

type Resultado = { ok: true; avisados: unknown } | { ok: false; error: string };

/** ¿El fallo de conexión es "nadie escucha en ese puerto"? */
function esRechazo(e: unknown): boolean {
  return inspect(e, { depth: 5 }).includes('ECONNREFUSED');
}

export class EnlaceIngesta {
  private socket: Socket | null = null;
  private intencion: Intencion | null = null;
  private relojAck: NodeJS.Timeout | null = null;
  private inalcanzable = false;
  private avisadoInalcanzable = false;
  private yaConecto = false;
  private _autenticado = false;
  private readonly version: string;
  private readonly avisos: Avisos;
  private readonly secreto: () => string;
  private readonly esperaAckMs: number;
  private readonly opcionesSocket: Partial<ManagerOptions & SocketOptions>;

  constructor(opciones: OpcionesEnlace) {
    this.version = opciones.version;
    this.avisos = opciones.avisos;
    this.secreto = opciones.secreto ?? (() => '');
    this.esperaAckMs = opciones.esperaAckMs ?? 10_000;
    this.opcionesSocket = opciones.opcionesSocket ?? {};
  }

  get autenticado(): boolean {
    return this._autenticado;
  }

  /** Hay socket (conectado, conectando o reintentando). */
  get abierto(): boolean {
    return this.socket !== null;
  }

  get rol(): 'observador' | 'jugador' | null {
    return this.intencion?.rol ?? null;
  }

  get porGrupo(): string | null {
    return this.intencion && 'grupo' in this.intencion && this.intencion.rol === 'jugador' ? this.intencion.grupo : null;
  }

  /* ── Abrir y cerrar ─────────────────────────────────────────────────────── */

  abre(url: string, intencion: Intencion): void {
    if (this.socket !== null) this.cierraSocket(true);
    this.intencion = intencion;
    this.inalcanzable = false;
    this.avisadoInalcanzable = false;
    this.yaConecto = false;
    this.avisos.estado('Connecting', 'warn');
    this.avisos.log(`abriendo socket de ${this.descripcion()} contra ${url}`);

    const s = io(url, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // El servidor puede ir con certificado propio: no se verifica (especificación §3.1.2).
      rejectUnauthorized: false,
      forceNew: true,
      ...this.opcionesSocket,
    });
    this.socket = s;

    s.on('connect', () => this.alConectar(s));
    s.on(this.eventoAck(), (msg: unknown) => this.alAcuse(s, msg));
    s.on('disconnect', (motivo) => this.alDesconectar(s, motivo));
    s.on('connect_error', (e) => this.alFallarConexion(s, e));
    s.io.on('reconnect_attempt', (n) => {
      if (this.socket !== s) return;
      this.avisos.estado('Reconnecting', 'warn');
      this.avisos.log(`reintento de conexión ${n}`);
    });
    s.io.on('reconnect', (n) => {
      if (this.socket === s) this.avisos.log(`transporte reconectado tras ${n} intentos: se repite el logon`);
    });
  }

  /**
   * Fin de conexión (fin de partida, o cierre pedido). Cierra el socket esté
   * como esté y marca desconectado.
   */
  cierra(estado = 'Connection Closed'): void {
    if (this.socket === null) return;
    this.cierraSocket(true);
    this.avisos.estado(estado, 'info');
  }

  private cierraSocket(marcar: boolean): void {
    const s = this.socket;
    this.socket = null;
    this.paraRelojAck();
    if (s !== null) {
      s.removeAllListeners();
      s.io.removeAllListeners();
      s.close();
    }
    if (marcar) this.marcaDesconectado();
  }

  private marcaDesconectado(): void {
    this._autenticado = false;
    this.avisos.desconectado();
    this.avisos.estado('Disconnected', 'info');
  }

  /* ── Logon, en cada `connect` ───────────────────────────────────────────── */

  private eventoAck(): string {
    return this.intencion?.rol === 'observador' ? 'obs_logon_ack' : 'aux_logon_ack';
  }

  private descripcion(): string {
    const i = this.intencion;
    if (i === null) return '?';
    if (i.rol === 'observador') return `observador (${i.grupo.toUpperCase()})`;
    return 'grupo' in i ? `jugador por grupo (${i.grupo})` : `jugador por matchId (${i.matchId})`;
  }

  private alConectar(s: Socket): void {
    if (this.socket !== s || this.intencion === null) return;
    this.yaConecto = true;
    this.inalcanzable = false;
    const i = this.intencion;
    if (i.rol === 'observador') {
      s.emit('obs_logon', JSON.stringify(logonObservador({ version: this.version, token: i.token, grupo: i.grupo, secreto: this.secreto() })));
    } else {
      const base = { version: this.version, nombre: i.nombre, puuid: i.puuid };
      s.emit('aux_logon', JSON.stringify(logonJugador('grupo' in i ? { ...base, grupo: i.grupo } : { ...base, matchId: i.matchId })));
    }
    this.avisos.log(`logon enviado (${this.descripcion()})`);
    this.paraRelojAck();
    this.relojAck = setTimeout(() => {
      if (this.socket !== s || this._autenticado) return;
      this.avisos.log(`sin acuse del logon en ${this.esperaAckMs} ms: se reintenta`);
      this.avisos.estado('Connection Failed', 'danger');
      // Desconexión del cliente (no reintenta sola) y conexión nueva: vuelve a pasar por `connect`.
      s.disconnect();
      s.connect();
    }, this.esperaAckMs);
  }

  private paraRelojAck(): void {
    if (this.relojAck !== null) clearTimeout(this.relojAck);
    this.relojAck = null;
  }

  private alAcuse(s: Socket, msg: unknown): void {
    if (this.socket !== s || this.intencion === null) return;
    const d = leeCarga(msg);
    const esperado = this.intencion.rol === 'observador' ? 'authenticate' : 'aux_authenticate';
    if (d === null || d.type !== esperado) return;
    this.paraRelojAck();
    const reason = typeof d.reason === 'string' ? d.reason : undefined;
    const porGrupo = this.intencion.rol === 'jugador' && 'grupo' in this.intencion;

    if (d.value === true) {
      this._autenticado = true;
      this.avisos.estado('Connected', 'success');
      this.avisos.log(`autenticado como ${this.descripcion()}${reason ? ` (${reason})` : ''}`);
      this.avisos.autenticado({
        rol: this.intencion.rol,
        reason,
        secreto: this.intencion.rol === 'observador' && reason !== 'reconnected' ? reason : undefined,
        porGrupo,
      });
      return;
    }

    this.avisos.log(`logon rechazado (${this.descripcion()}): ${reason ?? '(sin motivo)'}`);
    // El logon por grupo es automático ("Call players"): no se molesta al jugador con diálogos.
    if (!porGrupo) this.avisos.dialogo('Easy HUD', motivoAmable(reason), 'warning');
    this.cierraSocket(true);
    this.avisos.estado('Connection Failed', 'danger');
  }

  /* ── Caídas y fallos ────────────────────────────────────────────────────── */

  private alDesconectar(s: Socket, motivo: string): void {
    if (this.socket !== s) return;
    this.paraRelojAck();
    const eraAutenticado = this._autenticado;
    this._autenticado = false;
    this.avisos.log(`socket desconectado: ${motivo}`);
    if (s.active) {
      // Caída del transporte: socket.io reconecta solo y `connect` repetirá el logon.
      if (eraAutenticado) this.avisos.desconectado();
      this.avisos.estado('Reconnecting', 'warn');
      return;
    }
    // Cierre del servidor (fin de partido, token caducado…): no hay reconexión automática.
    const inalcanzable = this.inalcanzable;
    this.cierraSocket(true);
    if (inalcanzable) {
      this.avisos.estado('Server Unreachable', 'danger');
      this.avisos.dialogo('Easy HUD - Error', 'Easy HUD server not reachable!', 'error');
    } else {
      this.avisos.estado('Connection Closed', 'info');
    }
  }

  private alFallarConexion(s: Socket, e: Error): void {
    if (this.socket !== s) return;
    this.avisos.log(`fallo de conexión: ${e.message}`);
    if (esRechazo(e)) {
      this.inalcanzable = true;
      this.avisos.estado('Server Unreachable', 'danger');
      // Un solo diálogo por intento de conexión, y sólo si nunca llegó a conectar.
      if (!this.yaConecto && !this.avisadoInalcanzable && this.intencion?.rol === 'observador') {
        this.avisadoInalcanzable = true;
        this.avisos.dialogo('Easy HUD - Error', 'Easy HUD server not reachable!', 'error');
      }
    } else {
      this.avisos.estado(this.intencion?.rol === 'observador' ? 'Connection Closed' : 'Connection Failed', 'danger');
    }
    if (!s.active) {
      // Rechazo en el apretón de manos del servidor: socket.io no reintenta.
      this.cierraSocket(true);
    }
  }

  /* ── Envíos ─────────────────────────────────────────────────────────────── */

  /** `obs_data`. Sin conexión autenticada de observador, se descarta. */
  enviaObservador(type: string, data: unknown): boolean {
    const i = this.intencion;
    if (!this._autenticado || this.socket === null || i?.rol !== 'observador') return false;
    this.socket.emit('obs_data', JSON.stringify({ obsName: nombreDelToken(i.token), groupCode: i.grupo.toUpperCase(), type, data }));
    return true;
  }

  /** `aux_data`. Sin conexión autenticada de jugador, se descarta. */
  enviaJugador(type: string, data: unknown): boolean {
    const i = this.intencion;
    if (!this._autenticado || this.socket === null || i?.rol !== 'jugador') return false;
    const matchId = 'matchId' in i ? i.matchId : '';
    this.socket.emit('aux_data', JSON.stringify({ playerId: i.puuid, matchId, type, data }));
    return true;
  }

  /** `obs_lobby`. La sala nula no se manda nunca. */
  enviaSala(sala: unknown): boolean {
    const i = this.intencion;
    if (sala === null || !this._autenticado || this.socket === null || i?.rol !== 'observador') return false;
    this.socket.emit('obs_lobby', JSON.stringify({ obsName: nombreDelToken(i.token), groupCode: i.grupo.toUpperCase(), sala }));
    return true;
  }

  /** "Call players" (§3.1.6). */
  llamaJugadores(puuids: readonly string[], esperaMs = 5000): Promise<Resultado> {
    const s = this.socket;
    if (!this._autenticado || s === null || this.intencion?.rol !== 'observador') {
      return Promise.resolve({ ok: false, error: 'No conectado como observador.' });
    }
    return new Promise((resolve) => {
      const reloj = setTimeout(() => {
        s.off('llamar_jugadores_ack', oyente);
        resolve({ ok: false, error: 'El servidor no respondió.' });
      }, esperaMs);
      const oyente = (msg: unknown) => {
        clearTimeout(reloj);
        try {
          const d = JSON.parse(String(msg)) as { avisados?: unknown };
          resolve({ ok: true, avisados: d.avisados });
        } catch (e) {
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      };
      s.once('llamar_jugadores_ack', oyente);
      s.emit('llamar_jugadores', JSON.stringify({ puuids }));
    });
  }
}
