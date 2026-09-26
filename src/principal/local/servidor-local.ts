/**
 * El servidor local del overlay (127.0.0.1:5310, especificación §6).
 *
 * Dos cosas en el mismo puerto:
 *   · los ficheros del overlay (lo que OBS carga en `http://localhost:5310/`);
 *   · un relevo socket.io: cada overlay que se conecta aquí recibe un socket
 *     "hacia arriba" contra la salida (5200) del servidor de partidas, que es
 *     quien pone la credencial. El token vive sólo en la memoria de este
 *     proceso: no llega al navegador ni aparece en ninguna URL.
 *
 * Cambios respecto al cliente anterior:
 *   · el grupo del relevo va en mayúsculas, igual que el del logon del
 *     observador (antes uno iba tal cual y otro en mayúsculas);
 *   · al renovar credenciales, los relevos abiertos se rehacen con las nuevas
 *     (antes seguían con el token viejo hasta reconectar).
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server as ServidorHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket as SocketOverlay } from 'socket.io';
import { io as conectaArriba, type Socket as SocketArriba } from 'socket.io-client';
import { resuelveRuta, tipoDe } from './estaticos.ts';

export interface Credenciales {
  /** URL de salida derivada (…:5200). */
  endpoint: string;
  token: string;
  grupo: string;
}

export interface OpcionesServidorLocal {
  raiz: string;
  puerto: number;
  log: (texto: string) => void;
  /** Sólo pruebas: opciones extra del socket de arriba. */
  opcionesArriba?: Record<string, unknown>;
}

/** Eventos de arriba que se reenvían al overlay tal cual. `sala` y `/operador` no. */
const REENVIADOS = ['match_data', 'logon_success', 'logon_denied'] as const;

const ORIGEN_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

interface Relevo {
  overlay: SocketOverlay;
  arriba: SocketArriba | null;
}

export class ServidorLocal {
  private http: ServidorHttp | null = null;
  private io: Server | null = null;
  private credenciales: Credenciales | null = null;
  private readonly relevos = new Set<Relevo>();
  private readonly o: OpcionesServidorLocal;
  private puertoReal = 0;

  constructor(opciones: OpcionesServidorLocal) {
    this.o = opciones;
  }

  get enMarcha(): boolean {
    return this.http !== null;
  }

  get puerto(): number {
    return this.puertoReal;
  }

  /** Arranca, o si ya está en marcha sólo cambia las credenciales. */
  async arranca(credenciales: Credenciales): Promise<void> {
    const cambian =
      this.credenciales === null ||
      this.credenciales.token !== credenciales.token ||
      this.credenciales.grupo !== credenciales.grupo ||
      this.credenciales.endpoint !== credenciales.endpoint;
    this.credenciales = credenciales;
    if (this.http !== null) {
      if (cambian) {
        this.o.log('servidor local: credenciales renovadas, se rehacen los relevos abiertos');
        for (const r of this.relevos) this.abreArriba(r);
      }
      return;
    }

    const http = createServer((req, res) => void this.sirve(req.url ?? '/', res));
    const io = new Server(http, {
      cors: {
        origin: (origen, listo) => listo(null, origen === undefined || ORIGEN_LOCAL.test(origen)),
      },
    });
    io.on('connection', (s) => this.alConectarOverlay(s));
    this.http = http;
    this.io = io;
    http.on('error', (e) => this.o.log(`servidor local: error ${e.message}`));

    await new Promise<void>((resolve) => {
      const falla = (e: Error) => {
        // Sólo se registra (puerto ocupado, etc.); el siguiente `arranca` lo reintenta.
        this.o.log(`servidor local: no arranca en ${this.o.puerto} (${e.message})`);
        io.close();
        this.http = null;
        this.io = null;
        resolve();
      };
      http.once('error', falla);
      http.listen(this.o.puerto, '127.0.0.1', () => {
        http.off('error', falla);
        this.puertoReal = (http.address() as AddressInfo).port;
        this.o.log(`servidor local en http://localhost:${this.puertoReal}/ (raíz ${this.o.raiz})`);
        resolve();
      });
    });
  }

  async para(): Promise<void> {
    this.credenciales = null;
    for (const r of this.relevos) this.cierraRelevo(r);
    this.relevos.clear();
    const io = this.io;
    const http = this.http;
    this.io = null;
    this.http = null;
    this.puertoReal = 0;
    if (io !== null) await new Promise<void>((r) => io.close(() => r()));
    if (http !== null && http.listening) {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
    this.o.log('servidor local parado');
  }

  /* ── Estáticos ──────────────────────────────────────────────────────────── */

  private async sirve(url: string, res: import('node:http').ServerResponse): Promise<void> {
    const ruta = resuelveRuta(this.o.raiz, url);
    if (ruta === null) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    try {
      const contenido = await readFile(ruta);
      res.writeHead(200, { 'Content-Type': tipoDe(ruta), 'Cache-Control': 'no-store' });
      res.end(contenido);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  /* ── Relevo ─────────────────────────────────────────────────────────────── */

  private alConectarOverlay(overlay: SocketOverlay): void {
    if (this.credenciales === null) {
      overlay.emit('logon_denied', JSON.stringify({ reason: 'sin sesión en el programa' }));
      overlay.disconnect(true);
      return;
    }
    const relevo: Relevo = { overlay, arriba: null };
    this.relevos.add(relevo);
    // Lo que el overlay mande en su propio `logon` se ignora: la credencial la pone el programa.
    overlay.on('disconnect', () => {
      this.cierraRelevo(relevo);
      this.relevos.delete(relevo);
    });
    this.abreArriba(relevo);
  }

  private abreArriba(relevo: Relevo): void {
    const c = this.credenciales;
    if (relevo.arriba !== null) {
      relevo.arriba.removeAllListeners();
      relevo.arriba.close();
      relevo.arriba = null;
    }
    if (c === null) return;
    const arriba = conectaArriba(c.endpoint, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      forceNew: true,
      rejectUnauthorized: false,
      ...this.o.opcionesArriba,
    });
    relevo.arriba = arriba;
    const grupo = c.grupo.toUpperCase();
    arriba.on('connect', () => arriba.emit('logon', JSON.stringify({ groupCode: grupo, token: c.token })));
    for (const evento of REENVIADOS) {
      arriba.on(evento, (msg: unknown) => relevo.overlay.emit(evento, msg));
    }
    arriba.on('connect_error', () =>
      relevo.overlay.emit('logon_denied', JSON.stringify({ reason: 'el programa no llega al servidor' })),
    );
  }

  private cierraRelevo(relevo: Relevo): void {
    relevo.arriba?.removeAllListeners();
    relevo.arriba?.close();
    relevo.arriba = null;
  }
}
