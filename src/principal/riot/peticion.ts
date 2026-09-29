/**
 * Una petición HTTP(S) pequeña, con tiempo de espera, para la API local del
 * cliente de Riot y sus servidores.
 *
 * Existe porque la API local va con certificado autofirmado y `fetch` de Node
 * no deja desactivar la verificación por petición. Sólo se desactiva cuando se
 * pide (`inseguro`), que es exclusivamente contra 127.0.0.1.
 */

import { request as peticionHttp } from 'node:http';
import { request as peticionHttps } from 'node:https';

export interface Respuesta {
  estado: number;
  cuerpo: string;
  /** El cuerpo como JSON, o `null` si no lo es. */
  json(): unknown;
}

export interface OpcionesPeticion {
  metodo?: 'GET' | 'POST' | 'PUT';
  cabeceras?: Record<string, string>;
  cuerpo?: unknown;
  inseguro?: boolean;
  esperaMs?: number;
}

export function pide(url: string, o: OpcionesPeticion = {}): Promise<Respuesta> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const cuerpo = o.cuerpo === undefined ? undefined : JSON.stringify(o.cuerpo);
    const cabeceras: Record<string, string> = { ...o.cabeceras };
    if (cuerpo !== undefined) {
      cabeceras['Content-Type'] = 'application/json';
      cabeceras['Content-Length'] = String(Buffer.byteLength(cuerpo));
    }
    const hacer = u.protocol === 'http:' ? peticionHttp : peticionHttps;
    const req = hacer(
      u,
      { method: o.metodo ?? 'GET', headers: cabeceras, rejectUnauthorized: o.inseguro !== true, timeout: o.esperaMs ?? 4000 },
      (res) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => {
          const texto = Buffer.concat(trozos).toString('utf8');
          resolve({
            estado: res.statusCode ?? 0,
            cuerpo: texto,
            json() {
              try {
                return JSON.parse(texto);
              } catch {
                return null;
              }
            },
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`tiempo de espera agotado: ${u.host}`)));
    req.on('error', reject);
    if (cuerpo !== undefined) req.write(cuerpo);
    req.end();
  });
}

/** Objeto o nada: para leer respuestas sin fiarse de su forma. */
export function objeto(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
