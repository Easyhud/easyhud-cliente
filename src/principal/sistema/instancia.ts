/**
 * Instancia única con acuse.
 *
 * Electron sólo dice "ya hay otra instancia con el candado"; no dice si esa
 * otra responde. Antes, la segunda instancia se cerraba en silencio: si la
 * primera estaba colgada (o era un resto invisible), abrir la app no hacía
 * nada y el operador tenía que matar el proceso a mano.
 *
 * Ahora, en la carpeta de datos (la misma para las dos, y distinta entre
 * observador y jugador):
 *   · la primera escribe una ficha `instancia.json` con su PID al arrancar;
 *   · al recibir `second-instance` escribe `instancia-acuse` con la hora;
 *   · la segunda espera ese acuse unos segundos. Si llega, la primera ya se
 *     ha mostrado y avisado: se cierra. Si no llega, la primera no responde:
 *     se ofrece cerrarla y abrir de nuevo.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FICHA = 'instancia.json';
const ACUSE = 'instancia-acuse';

export interface Ficha {
  pid: number;
  inicio: number;
}

export function escribeFicha(carpeta: string, pid: number, ahora = Date.now()): void {
  try {
    writeFileSync(join(carpeta, FICHA), JSON.stringify({ pid, inicio: ahora }));
  } catch {
    // Sin ficha la segunda instancia sólo pierde el PID exacto: buscará restos.
  }
}

export function leeFicha(carpeta: string): Ficha | null {
  try {
    const d = JSON.parse(readFileSync(join(carpeta, FICHA), 'utf8')) as Partial<Ficha>;
    return Number.isInteger(d.pid) && typeof d.inicio === 'number' ? { pid: d.pid as number, inicio: d.inicio } : null;
  } catch {
    return null;
  }
}

/** La primera instancia confirma que recibió el aviso de la segunda. */
export function acusa(carpeta: string, ahora = Date.now()): void {
  try {
    writeFileSync(join(carpeta, ACUSE), String(ahora));
  } catch {
    // Sin acuse la segunda creerá que ésta no responde y lo preguntará: molesto, no grave.
  }
}

function leeAcuse(carpeta: string): number {
  try {
    return Number(readFileSync(join(carpeta, ACUSE), 'utf8')) || 0;
  } catch {
    return 0;
  }
}

/** Espera un acuse posterior a `desde`. Devuelve si llegó. */
export async function esperaAcuse(carpeta: string, desde: number, esperaMs = 4000, pasoMs = 50): Promise<boolean> {
  const hasta = Date.now() + esperaMs;
  for (;;) {
    if (leeAcuse(carpeta) >= desde) return true;
    if (Date.now() >= hasta) return false;
    await new Promise((s) => setTimeout(s, pasoMs));
  }
}
