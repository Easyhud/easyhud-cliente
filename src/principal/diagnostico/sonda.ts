/**
 * Sonda de red: ¿se llega al servidor por HTTP?
 *
 * Cuando el socket de presencia no conecta, la causa puede ser muy distinta (sin internet, el servidor
 * caído, un cortafuegos que bloquea WebSocket pero deja pasar HTTP). Esta sonda pide `GET /status` al
 * puerto de «extras» (el de ingesta + 1) y devuelve un motivo legible, para enseñarlo al jugador y al
 * operador en vez de un «no conecta» sin más.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface ResultadoSonda {
  ok: boolean;
  /** Vacío si fue bien; si no, qué pasó con palabras del jugador. */
  motivo: string;
}

/** La URL de la sonda a partir de la de ingesta (`http://host:5100` → `http://host:5101/status`). */
export function urlSonda(ingesta: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(ingesta) ? ingesta : `https://${ingesta}`);
    const puerto = u.port === '' ? 5100 : Number(u.port);
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65534) return null;
    u.port = String(puerto + 1);
    u.pathname = '/status';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Traduce el código de error de red a algo que el jugador entienda. */
export function motivoDeError(e: unknown): string {
  const codigo = (e as { code?: string } | null)?.code ?? '';
  switch (codigo) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'no internet (the server name could not be resolved)';
    case 'ECONNREFUSED':
      return 'the server refused the connection (it may be down or restarting)';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'the server did not answer in time (firewall, VPN or bad connection)';
    case 'ECONNRESET':
      return 'the connection was cut (firewall or unstable connection)';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'no route to the server (no internet?)';
    default:
      return codigo !== '' ? `network error ${codigo}` : e instanceof Error ? e.message.slice(0, 100) : 'unknown network error';
  }
}

export function sondea(url: string, tiempoMs = 4000): Promise<ResultadoSonda> {
  return new Promise((resolve) => {
    let hecho = false;
    const fin = (r: ResultadoSonda) => {
      if (hecho) return;
      hecho = true;
      resolve(r);
    };
    try {
      const pide = url.startsWith('https:') ? httpsRequest : httpRequest;
      const req = pide(url, { method: 'GET', timeout: tiempoMs, rejectUnauthorized: false } as never, (res) => {
        res.resume();
        const bien = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400;
        fin(bien ? { ok: true, motivo: '' } : { ok: false, motivo: `the server answered HTTP ${res.statusCode}` });
      });
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      });
      req.on('error', (e) => fin({ ok: false, motivo: motivoDeError(e) }));
      req.end();
    } catch (e) {
      fin({ ok: false, motivo: motivoDeError(e) });
    }
  });
}
