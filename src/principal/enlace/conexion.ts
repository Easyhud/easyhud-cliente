/**
 * El socket de datos contra la ingesta (puerto 5100).
 *
 * Uno solo a la vez, con uno de tres papeles:
 *   · observador            (`obs_logon`, luego `obs_data`/`obs_lobby`/`llamar_jugadores`)
 *   · jugador por matchId   (`aux_logon` con matchId, luego `aux_data`)
 *   · jugador por grupo     (`aux_logon` con groupCode, tras `te_llaman`)
 *
 * Reglas de este módulo:
 *
 *   1. El logon se repite en CADA evento `connect` del socket (el inicial y
 *      los de las reconexiones automáticas de socket.io). El servidor ve cada
 *      reconexión como un socket nuevo sin autenticar, así que hay que
 *      volver a autenticarse en cada una. Hasta que llega el acuse no se da
 *      por conectado.
 *   2. Se escuchan los eventos que socket.io 4 emite de verdad: en el socket
 *      `connect`, `disconnect` y `connect_error`; en el gestor (`socket.io`)
 *      `reconnect_attempt` y `reconnect`.
 *   3. Al abrir uno nuevo se cierra el anterior esté como esté (conectado o
 *      reintentando): no quedan sockets fantasma con oyentes duplicados.
 *   4. Un logon sin acuse en `esperaAckMs` se da por fallido y se reintenta: es una
 *      reconexión INTERNA (el socket y sus oyentes se conservan, no se pasa por
 *      «cerrado») que vuelve a hacer el logon al reabrir. Tras `MAX_REINTENTOS_ACK`
 *      fallos seguidos, con espera creciente, se da por perdido («Connection Failed»).
 *
 * No sabe nada de Electron: avisa por la interfaz `Avisos` y quien lo usa
 * decide si eso es un diálogo, el título de la ventana o una línea de log.
 */

import { inspect } from 'node:util';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { ClaseEstado } from '../gep/acciones.ts';
import { leeCarga, logonJugador, logonObservador, motivoAmable, motivoDeFalloDeRed, nombreDelToken } from './mensajes.ts';

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
  /** `cam_config` del servidor (sólo llega a los jugadores). */
  camara?(carga: unknown): void;
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
  /** Espera antes de volver a entrar cuando el servidor cierra al observador (por defecto 3 s). */
  reintentoCierreMs?: number;
  /** Espera base antes de reabrir tras un logon sin acuse; crece con cada intento (por defecto 1 s). */
  reintentoAckBaseMs?: number;
  /** Opciones extra del socket (las pruebas acortan tiempos). */
  opcionesSocket?: Partial<ManagerOptions & SocketOptions>;
  /** Fábrica del socket (las pruebas ponen uno falso). Por defecto `io` de socket.io-client. */
  crearSocket?: (url: string, opciones: Partial<ManagerOptions & SocketOptions>) => Socket;
}

/** Cuántas veces seguidas se vuelve a entrar tras un cierre del servidor antes de darlo por perdido. */
const MAX_REINTENTOS_CIERRE = 20;

/** Cuántos logon seguidos sin acuse se reintentan antes de darlo por perdido. */
const MAX_REINTENTOS_ACK = 5;

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
  private reintentosCierre = 0;
  /** Logon sin acuse reintentados seguidos (se pone a 0 con un acuse o al abrir de nuevo). */
  private reintentosAck = 0;
  /** Verdadero mientras el propio programa corta el socket para reabrirlo: ese `disconnect` no es un cierre. */
  private reabriendo = false;
  private relojReintentoAck: NodeJS.Timeout | null = null;
  private _autenticado = false;
  private readonly version: string;
  private readonly avisos: Avisos;
  private readonly secreto: () => string;
  private readonly esperaAckMs: number;
  private readonly reintentoCierreMs: number;
  private readonly reintentoAckBaseMs: number;
  private readonly opcionesSocket: Partial<ManagerOptions & SocketOptions>;
  private readonly crearSocket: (url: string, opciones: Partial<ManagerOptions & SocketOptions>) => Socket;

  constructor(opciones: OpcionesEnlace) {
    this.version = opciones.version;
    this.avisos = opciones.avisos;
    this.secreto = opciones.secreto ?? (() => '');
    this.esperaAckMs = opciones.esperaAckMs ?? 10_000;
    this.reintentoCierreMs = opciones.reintentoCierreMs ?? 3000;
    this.reintentoAckBaseMs = opciones.reintentoAckBaseMs ?? 1000;
    this.opcionesSocket = opciones.opcionesSocket ?? {};
    this.crearSocket = opciones.crearSocket ?? ((url, o) => io(url, o));
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
    this.reintentosAck = 0;
    this.avisos.estado('Connecting', 'warn');
    this.avisos.log(`abriendo socket de ${this.descripcion()} contra ${url}`);

    const s = this.crearSocket(url, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // El servidor puede ir con certificado propio: no se verifica.
      rejectUnauthorized: false,
      forceNew: true,
      ...this.opcionesSocket,
    });
    this.socket = s;

    s.on('connect', () => this.alConectar(s));
    s.on(this.eventoAck(), (msg: unknown) => this.alAcuse(s, msg));
    s.on('cam_config', (msg: unknown) => {
      if (this.socket === s) this.avisos.camara?.(leeCarga(msg));
    });
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
    if (this.relojReintentoAck !== null) clearTimeout(this.relojReintentoAck);
    this.relojReintentoAck = null;
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
    this.relojAck = setTimeout(() => this.sinAcuse(s), this.esperaAckMs);
  }

  /**
   * Pasó el plazo sin acuse del logon. Se corta el socket y se vuelve a abrir (así vuelve a pasar por
   * `connect` y a hacer el logon), pero SIN tratarlo como un cierre: el socket y sus oyentes siguen y el
   * estado no pasa por «cerrado». La espera crece con cada intento; agotados, se da por perdido.
   */
  private sinAcuse(s: Socket): void {
    if (this.socket !== s || this._autenticado) return;
    if (this.reintentosAck >= MAX_REINTENTOS_ACK) {
      this.avisos.log(`sin acuse del logon tras ${MAX_REINTENTOS_ACK} reintentos: se da por perdido`);
      this.cierraSocket(true);
      this.avisos.estado('Connection Failed', 'danger');
      return;
    }
    this.reintentosAck += 1;
    const espera = this.reintentoAckBaseMs * this.reintentosAck;
    this.avisos.log(`sin acuse del logon en ${this.esperaAckMs} ms: se reintenta en ${espera} ms (${this.reintentosAck}/${MAX_REINTENTOS_ACK})`);
    this.avisos.estado('Reconnecting', 'warn');
    // `disconnect()` emite `disconnect` al instante: `alDesconectar` debe ignorarlo.
    this.reabriendo = true;
    try {
      s.disconnect();
    } finally {
      this.reabriendo = false;
    }
    this.relojReintentoAck = setTimeout(() => {
      this.relojReintentoAck = null;
      if (this.socket === s) s.connect();
    }, espera);
    this.relojReintentoAck.unref?.();
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
      this.reintentosCierre = 0;
      this.reintentosAck = 0;
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
    if (this.socket !== s || this.reabriendo) return;
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
    // El servidor cerró a un OBSERVADOR que estaba dentro (reinicio o despliegue del servidor,
    // partido caducado…): socket.io no reconecta solo en ese caso, así que se reintenta aquí.
    // Antes se daba por terminado y había que pulsar Reconnect a mano cada vez. El fin de
    // partido no pasa por aquí: el programa cierra él mismo (`cierra`) y este socket ya no existe.
    if (this.intencion?.rol === 'observador' && eraAutenticado && this.reintentosCierre < MAX_REINTENTOS_CIERRE) {
      this.reintentosCierre += 1;
      this.avisos.desconectado();
      this.avisos.estado('Reconnecting', 'warn');
      this.avisos.log(`el servidor cerró la conexión: se reintenta en ${this.reintentoCierreMs} ms (${this.reintentosCierre}/${MAX_REINTENTOS_CIERRE})`);
      const t = setTimeout(() => {
        if (this.socket === s) s.connect();
      }, this.reintentoCierreMs);
      t.unref?.();
      return;
    }
    // Cierre del servidor (fin de partido, token caducado…): no hay reconexión automática.
    const inalcanzable = this.inalcanzable;
    this.cierraSocket(true);
    if (inalcanzable) {
      this.avisos.estado('Server Unreachable', 'danger');
      this.avisos.dialogo(
        'Easy HUD - Server not reachable',
        'The Easy HUD server closed the connection and is not accepting new ones (it may be restarting). Press Ctrl+Alt+R (Reconnect everything) in a minute; if it still fails, tell the organizer.',
        'error',
      );
    } else {
      this.avisos.estado('Connection Closed', 'info');
    }
  }

  private alFallarConexion(s: Socket, e: Error): void {
    if (this.socket !== s) return;
    this.avisos.log(`fallo de conexión: ${e.message}`);
    const causa = motivoDeFalloDeRed(inspect(e, { depth: 5 }));
    if (esRechazo(e)) {
      this.inalcanzable = true;
      this.avisos.estado('Server Unreachable', 'danger');
    } else {
      this.avisos.estado(this.intencion?.rol === 'observador' ? 'Connection Closed' : 'Connection Failed', 'danger');
    }
    // Un solo diálogo por intento de conexión, y sólo si nunca llegó a conectar: qué pasó y qué hacer.
    if (causa !== null && !this.yaConecto && !this.avisadoInalcanzable && this.intencion?.rol === 'observador') {
      this.avisadoInalcanzable = true;
      this.avisos.dialogo(`Easy HUD - ${causa.titulo}`, causa.texto, 'error');
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

  /** `obs_lobby`. `null` = ya no hay sala (el servidor se olvida de la vieja). */
  enviaSala(sala: unknown): boolean {
    const i = this.intencion;
    if (!this._autenticado || this.socket === null || i?.rol !== 'observador') return false;
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
