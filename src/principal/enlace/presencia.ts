/**
 * Presencia del jugador.
 *
 * Un socket propio, independiente del de datos, que late `cliente_presente`
 * con el puuid al conectar y cada 12 s. Así el operador sabe quién tiene el
 * programa abierto y el servidor sabe a quién mandar `te_llaman` cuando el
 * panel pulsa "Call players".
 *
 * Cada latido lleva además el diagnóstico del programa (GEP, juego, conexión…) y pide acuse al
 * servidor: así se sabe que el servidor OYE (y no sólo que el socket está abierto), y un socket
 * medio muerto se reconecta solo. Si la red bloquea WebSocket, cae a sondeo HTTP.
 */

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { CargaDiagnostico, EstadoRed } from '../diagnostico/diagnostico.ts';
import { leeCarga } from './mensajes.ts';

export interface OpcionesPresencia {
  url: string;
  puuid: () => string;
  /** `codigo`: el de la sala de Riot si ya existe (vacío si no). */
  alLlamar: (grupo: string, codigo: string) => void;
  log: (texto: string) => void;
  periodoMs?: number;
  /** Espera antes de volver a conectar si el servidor cierra (por defecto 3 s). */
  reintentoMs?: number;
  /** El operador pide el informe completo (la «caja negra»). */
  alPedirInforme?: () => void;
  /** Una orden remota del operador (sólo las de la lista que entiende el programa). */
  alOrdenRemota?: (accion: string) => void;
  /** Lo que el programa cuenta de sí mismo; va con cada latido. */
  diagnostico?: () => CargaDiagnostico;
  /** Cuánto sin acuse del servidor (habiendo recibido alguno) para dar el socket por muerto (por defecto 40 s). */
  acuseMaxMs?: number;
  /** El reloj (inyectable para probar). */
  ahora?: () => number;
  opcionesSocket?: Partial<ManagerOptions & SocketOptions>;
}

export class Presencia {
  private socket: Socket | null = null;
  private reloj: NodeJS.Timeout | null = null;
  private ultimoPuuid = '';
  private readonly o: OpcionesPresencia;
  private readonly ahora: () => number;
  /** Desde cuándo está el socket en su estado actual (conectado / no). */
  private desde: number;
  private ultimoAck = 0;
  /** Se ha mandado algún latido desde que conectó. */
  private latio = false;
  private conectoAlgunaVez = false;
  /** El servidor ha acusado recibo alguna vez: sólo entonces la falta de acuse es señal de que algo va mal. */
  private servidorAcusa = false;
  private ultimoFallo = '';
  private intentos = 0;

  constructor(opciones: OpcionesPresencia) {
    this.o = opciones;
    this.ahora = opciones.ahora ?? Date.now;
    this.desde = this.ahora();
  }

  /** Cómo va la conexión con el servidor, para el diagnóstico y las alertas. */
  estadoRed(): EstadoRed {
    const t = this.ahora();
    const conectada = this.socket?.connected === true;
    return {
      conectada,
      desdeMs: t - this.desde,
      conectoAlgunaVez: this.conectoAlgunaVez,
      latiendo: conectada && this.latio,
      oidoPorServidor: conectada && this.servidorAcusa && t - this.ultimoAck < (this.o.acuseMaxMs ?? 40_000),
      ultimoFallo: this.ultimoFallo,
      intentos: this.intentos,
    };
  }

  /** Un motivo de fallo más preciso que el del socket (lo da la sonda HTTP). */
  fijaFallo(motivo: string): void {
    this.ultimoFallo = motivo;
  }

  arranca(): void {
    if (this.socket !== null) return;
    const s = io(this.o.url, {
      // WebSocket primero; si una red lo bloquea (proxy, cortafuegos), cae a sondeo HTTP en vez de no conectar nunca.
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      timeout: 10_000,
      rejectUnauthorized: false,
      forceNew: true,
      ...this.o.opcionesSocket,
    });
    this.socket = s;
    s.on('connect', () => {
      this.o.log('presencia conectada');
      this.desde = this.ahora();
      this.conectoAlgunaVez = true;
      this.latio = false;
      this.ultimoFallo = '';
      this.intentos = 0;
      this.ultimoAck = this.ahora(); // un margen antes de exigir acuses
      this.late();
    });
    s.on('connect_error', (e: Error) => {
      this.intentos += 1;
      this.ultimoFallo = String(e.message).slice(0, 120);
      if (this.intentos === 1 || this.intentos % 10 === 0) {
        this.o.log(`presencia: no conecta (${this.ultimoFallo}), intento ${this.intentos}`);
      }
    });
    s.on('disconnect', (motivo) => {
      this.o.log(`presencia desconectada: ${motivo}`);
      this.desde = this.ahora();
      this.ultimoFallo = String(motivo);
      // Si lo cierra el SERVIDOR (reinicio o despliegue), socket.io no reconecta solo: sin esto el
      // programa seguía abierto pero el panel lo veía «No app» para siempre.
      if (!s.active) {
        const t = setTimeout(() => {
          if (this.socket === s && !s.connected) s.connect();
        }, this.o.reintentoMs ?? 3000);
        t.unref?.();
      }
    });
    s.on('orden_remota', (msg: unknown) => {
      const accion = leeCarga(msg)?.accion;
      if (typeof accion === 'string') {
        this.o.log(`orden remota del operador: ${accion}`);
        this.o.alOrdenRemota?.(accion);
      }
    });
    s.on('pide_informe', () => {
      this.o.log('el operador pide el informe completo');
      this.o.alPedirInforme?.();
    });
    s.on('te_llaman', (msg: unknown) => {
      const grupo = leeCarga(msg)?.groupCode;
      if (typeof grupo !== 'string' || grupo === '') return;
      const codigo = leeCarga(msg)?.inviteCode;
      this.o.log(`te_llaman del grupo ${grupo}`);
      this.o.alLlamar(grupo, typeof codigo === 'string' ? codigo : '');
    });
    this.reloj = setInterval(() => this.late(), this.o.periodoMs ?? 12_000);
  }

  /** Manda el informe completo al servidor (para que el operador lo lea). `true` si lo guardó. */
  enviaInforme(texto: string): Promise<boolean> {
    const puuid = this.o.puuid();
    const s = this.socket;
    if (puuid === '' || s === null || !s.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15_000);
      s.emit('informe_cliente', JSON.stringify({ puuid, informe: texto }), (r: unknown) => {
        clearTimeout(t);
        resolve(typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === true);
      });
    });
  }

  /** Latido: sólo con puuid conocido y socket conectado. */
  late(): void {
    const puuid = this.o.puuid();
    if (puuid === '' || this.socket?.connected !== true) return;
    if (puuid !== this.ultimoPuuid) {
      this.ultimoPuuid = puuid;
      this.o.log(`presencia: latiendo con el puuid ${puuid.slice(0, 8)}…`);
    }
    const carga: Record<string, unknown> = { puuid };
    try {
      const d = this.o.diagnostico?.();
      if (d !== undefined) carga.estado = d;
    } catch (e) {
      this.o.log(`presencia: no se pudo armar el diagnóstico (${e instanceof Error ? e.message : String(e)})`);
    }
    this.latio = true;
    // Con acuse: así se sabe que el servidor OYE, no sólo que el socket sigue abierto.
    this.socket.emit('cliente_presente', JSON.stringify(carga), (r: unknown) => {
      if (r !== null && typeof r === 'object') {
        this.servidorAcusa = true;
        this.ultimoAck = this.ahora();
      }
    });
    this.vigilaAcuse();
  }

  /**
   * Un socket que dice estar conectado pero no recibe acuses (medio muerto: un cambio de red, un
   * proxy que lo retiene) no se arregla solo. Si el servidor acusaba y deja de hacerlo, se fuerza
   * una reconexión. Un servidor antiguo (que nunca acusa) no activa esto.
   */
  private vigilaAcuse(): void {
    const s = this.socket;
    if (s === null || !this.servidorAcusa) return;
    if (this.ahora() - this.ultimoAck < (this.o.acuseMaxMs ?? 40_000)) return;
    this.o.log('presencia: el servidor dejó de acusar recibo; se fuerza la reconexión');
    this.ultimoAck = this.ahora();
    this.ultimoFallo = 'the server stopped answering';
    s.disconnect();
    const t = setTimeout(() => {
      if (this.socket === s && !s.connected) s.connect();
    }, 500);
    t.unref?.();
  }

  /** Corta y vuelve a abrir la conexión de presencia (orden remota de reconectar). */
  reconecta(): void {
    const s = this.socket;
    if (s === null) return;
    s.disconnect();
    const t = setTimeout(() => {
      if (this.socket === s && !s.connected) s.connect();
    }, 300);
    t.unref?.();
  }

  para(): void {
    if (this.reloj !== null) clearInterval(this.reloj);
    this.reloj = null;
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
  }
}
