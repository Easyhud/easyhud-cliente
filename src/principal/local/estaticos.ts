/**
 * Ficheros estáticos del servidor local: de una ruta
 * pedida a un fichero dentro de la raíz del overlay, y su tipo.
 */

import { extname, resolve, sep } from 'node:path';

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};

export function tipoDe(ruta: string): string {
  return TIPOS[extname(ruta).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * La ruta en disco que corresponde a una URL pedida, o `null` si se sale de
 * la raíz (→ 403). Una ruta acabada en `/` sirve su `index.html`.
 */
export function resuelveRuta(raiz: string, url: string): string | null {
  let ruta: string;
  try {
    ruta = decodeURIComponent((url || '/').split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (ruta.includes('\0')) return null;
  if (ruta.endsWith('/')) ruta += 'index.html';
  const base = resolve(raiz);
  const destino = resolve(base, `.${ruta.startsWith('/') ? '' : '/'}${ruta}`);
  if (destino !== base && !destino.startsWith(base + sep)) return null;
  return destino;
}
