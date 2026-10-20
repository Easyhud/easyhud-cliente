/**
 * Autoprueba de red: dónde se corta exactamente la conexión con el servidor.
 *
 * «No conecta» puede ser cuatro cosas muy distintas, y arreglarlas es distinto en cada una:
 *   1. el nombre del servidor no se resuelve (sin internet, DNS);
 *   2. el puerto no responde por TCP (cortafuegos, antivirus, el servidor caído);
 *   3. responde por HTTP pero no por WebSocket (un proxy o antivirus que lo corta);
 *   4. todo responde y el fallo está en otro sitio.
 * Se prueban en orden y se devuelve el resultado de cada paso, con una causa probable y qué hacer. Es lo
 * que ve el jugador en su ventana y lo que viaja al panel del operador.
 */

import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { io } from 'socket.io-client';
import { sondea, urlSonda } from './sonda.ts';

export type Arreglo = 'firewall' | 'internet' | 'servidor' | 'proxy';

export interface Prueba {
  id: 'dns' | 'tcp' | 'http' | 'websocket';
  nombre: string;
  /** `null` = no se pudo probar (un paso anterior falló). */
  ok: boolean | null;
  detalle: string;
  /** Qué ayudaría si falló este paso. */
  arreglo?: Arreglo;
}

export interface ResultadoAutoprueba {
  pruebas: Prueba[];
  /** Todo bien. */
  ok: boolean;
  /** Una frase para el panel del operador y el log. */
  resumen: string;
  /** El primer paso que falló y qué hacer. */
  causa: { arreglo: Arreglo; texto: string } | null;
  hechaEn: number;
}

export interface OpcionesAutoprueba {
  /** La URL de ingesta tal cual la usa el programa (`http://host:5100`). */
  url: string;
  /** Plazo por paso (por defecto 5 s). */
  tiempoMs?: number;
  ahora?: () => number;
}

function parte(url: string): { host: string; puerto: number; https: boolean } | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const https = u.protocol === 'https:';
    return { host: u.hostname, puerto: u.port === '' ? (https ? 443 : 80) : Number(u.port), https };
  } catch {
    return null;
  }
}

const conTiempo = <T>(p: Promise<T>, ms: number, aviso: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(aviso), { code: 'ETIMEDOUT' })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

function tcp(host: string, puerto: number, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port: puerto });
    const falla = (e: Error) => {
      s.destroy();
      reject(e);
    };
    s.setTimeout(ms, () => falla(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    s.once('error', falla);
    s.once('connect', () => {
      s.destroy();
      resolve();
    });
  });
}

function websocket(url: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: ms, rejectUnauthorized: false });
    const t = setTimeout(() => {
      s.close();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, ms + 500);
    s.once('connect', () => {
      clearTimeout(t);
      s.close();
      resolve();
    });
    s.once('connect_error', (e) => {
      clearTimeout(t);
      s.close();
      reject(e);
    });
  });
}

const codigoDe = (e: unknown): string => (e as { code?: string } | null)?.code ?? '';

export async function ejecutaAutoprueba(o: OpcionesAutoprueba): Promise<ResultadoAutoprueba> {
  const ms = o.tiempoMs ?? 5000;
  const ahora = o.ahora ?? Date.now;
  const p = parte(o.url);
  const pruebas: Prueba[] = [];

  const sinProbar = (id: Prueba['id'], nombre: string): void => {
    pruebas.push({ id, nombre, ok: null, detalle: 'not tested (an earlier step failed)' });
  };

  if (p === null) {
    pruebas.push({ id: 'dns', nombre: 'Server name', ok: false, detalle: `the server address "${o.url}" is not valid`, arreglo: 'servidor' });
    sinProbar('tcp', 'Server port');
    sinProbar('http', 'Server web');
    sinProbar('websocket', 'Real-time connection');
  } else {
    // 1. Resolver el nombre (si ya es una IP, sale solo).
    let dnsOk = true;
    try {
      const r = await conTiempo(lookup(p.host), ms, 'timeout');
      pruebas.push({ id: 'dns', nombre: 'Server name', ok: true, detalle: `${p.host} → ${r.address}` });
    } catch (e) {
      dnsOk = false;
      pruebas.push({
        id: 'dns',
        nombre: 'Server name',
        ok: false,
        detalle: `could not resolve ${p.host} (${codigoDe(e) || 'error'})`,
        arreglo: 'internet',
      });
    }

    // 2. El puerto, por TCP.
    let tcpOk = false;
    if (!dnsOk) {
      sinProbar('tcp', 'Server port');
    } else {
      try {
        await tcp(p.host, p.puerto, ms);
        tcpOk = true;
        pruebas.push({ id: 'tcp', nombre: 'Server port', ok: true, detalle: `port ${p.puerto} answers` });
      } catch (e) {
        const c = codigoDe(e);
        pruebas.push({
          id: 'tcp',
          nombre: 'Server port',
          ok: false,
          detalle:
            c === 'ECONNREFUSED'
              ? `port ${p.puerto} refused the connection (the server may be down or restarting)`
              : `port ${p.puerto} does not answer (${c || 'blocked'}) — a firewall, antivirus or VPN may be blocking it`,
          arreglo: c === 'ECONNREFUSED' ? 'servidor' : 'firewall',
        });
      }
    }

    // 3. HTTP al puerto de «extras».
    const web = urlSonda(o.url);
    let httpOk = false;
    if (!dnsOk || web === null) {
      sinProbar('http', 'Server web');
    } else {
      const r = await sondea(web, ms);
      httpOk = r.ok;
      pruebas.push({
        id: 'http',
        nombre: 'Server web',
        ok: r.ok,
        detalle: r.ok ? 'the server health check answers' : r.motivo,
        arreglo: r.ok ? undefined : tcpOk ? 'servidor' : 'firewall',
      });
    }

    // 4. WebSocket de verdad (lo que usa el programa).
    if (!dnsOk) {
      sinProbar('websocket', 'Real-time connection');
    } else {
      try {
        await websocket(o.url, ms);
        pruebas.push({ id: 'websocket', nombre: 'Real-time connection', ok: true, detalle: 'WebSocket connected' });
      } catch (e) {
        pruebas.push({
          id: 'websocket',
          nombre: 'Real-time connection',
          ok: false,
          detalle:
            tcpOk || httpOk
              ? `the port answers but the real-time connection fails (${String((e as Error)?.message ?? e).slice(0, 60)}) — a proxy or antivirus may be cutting WebSocket`
              : `could not open the real-time connection (${codigoDe(e) || String((e as Error)?.message ?? e).slice(0, 60)})`,
          arreglo: tcpOk || httpOk ? 'proxy' : 'firewall',
        });
      }
    }
  }

  const primero = pruebas.find((x) => x.ok === false);
  const causa = primero?.arreglo !== undefined ? { arreglo: primero.arreglo, texto: `${primero.nombre}: ${primero.detalle}` } : null;
  const resumen = pruebas
    .map((x) => `${x.nombre.toLowerCase()} ${x.ok === null ? '—' : x.ok ? 'ok' : 'FAILS'}`)
    .join(', ');
  return { pruebas, ok: pruebas.every((x) => x.ok === true), resumen, causa, hechaEn: ahora() };
}

/** Qué hacer según la causa, con palabras del jugador. */
export function consejo(arreglo: Arreglo): string {
  switch (arreglo) {
    case 'internet':
      return 'There is no internet access (or DNS is failing). Check your connection.';
    case 'firewall':
      return 'The server port is being blocked. Allow Easy HUD through the Windows Firewall (button below), and check your antivirus or VPN.';
    case 'proxy':
      return 'The server answers but the real-time connection is cut. Disable any VPN/proxy and allow Easy HUD in your antivirus.';
    case 'servidor':
      return 'The server is not accepting connections right now. Tell the operator.';
  }
}
