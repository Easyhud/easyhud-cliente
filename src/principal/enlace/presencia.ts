/**
 * Presencia del jugador (especificación §3.4).
 *
 * Un socket propio, independiente del de datos, que late `cliente_presente`
 * con el puuid al conectar y cada 12 s. Así el operador sabe quién tiene el
 * programa abierto y el servidor sabe a quién mandar `te_llaman` cuando el
 * panel pulsa "Call players".
 *
 * La URL va tal cual (sin normalizar) y sólo por WebSocket.
 */

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { leeCarga } from './mensajes.ts';

export interface OpcionesPresencia {
  url: string;
  puuid: () => string;
  alLlamar: (grupo: string) => void;
  log: (texto: string) => void;
  periodoMs?: number;
  opcionesSocket?: Partial<ManagerOptions & SocketOptions>;
}

export class Presencia {
  private socket: Socket | null = null;
  private reloj: NodeJS.Timeout | null = null;
  private readonly o: OpcionesPresencia;

  constructor(opciones: OpcionesPresencia) {
    this.o = opciones;
  }

  arranca(): void {
    if (this.socket !== null) return;
    const s = io(this.o.url, {
      transports: ['websocket'],
      reconnection: true,
      rejectUnauthorized: false,
      forceNew: true,
      ...this.o.opcionesSocket,
    });
    this.socket = s;
    s.on('connect', () => {
      this.o.log('presencia conectada');
      this.late();
    });
    s.on('disconnect', (motivo) => this.o.log(`presencia desconectada: ${motivo}`));
    s.on('te_llaman', (msg: unknown) => {
      const grupo = leeCarga(msg)?.groupCode;
      if (typeof grupo !== 'string' || grupo === '') return;
      this.o.log(`te_llaman del grupo ${grupo}`);
      this.o.alLlamar(grupo);
    });
    this.reloj = setInterval(() => this.late(), this.o.periodoMs ?? 12_000);
  }

  /** Latido: sólo con puuid conocido y socket conectado. */
  late(): void {
    const puuid = this.o.puuid();
    if (puuid === '' || this.socket?.connected !== true) return;
    this.socket.emit('cliente_presente', JSON.stringify({ puuid }));
  }

  para(): void {
    if (this.reloj !== null) clearInterval(this.reloj);
    this.reloj = null;
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
  }
}
