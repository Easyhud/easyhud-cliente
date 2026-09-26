/**
 * Conflicto con el Overwolf "de escritorio" (especificación §8.4).
 *
 * Si el cliente normal de Overwolf está abierto, su GEP y el de ow-electron se
 * pisan y los datos del juego fallan. Se buscan procesos `Overwolf.exe` y se
 * ofrece cerrarlos. Cambio: se cierra el proceso por el que se preguntó (su
 * PID), no siempre el primero de la lista.
 */

import { execFile } from 'node:child_process';

/** PIDs de `Overwolf.exe` en la salida CSV de `tasklist /FO CSV /NH`. */
export function pidsDeTasklist(salida: string): number[] {
  const pids: number[] = [];
  for (const linea of salida.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(linea.trim());
    if (m && m[1].toLowerCase() === 'overwolf.exe') pids.push(Number(m[2]));
  }
  return pids;
}

function ejecuta(programa: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(programa, args, { windowsHide: true, timeout: 10_000 }, (e, stdout) => (e ? reject(e) : resolve(stdout)));
  });
}

export async function buscaOverwolf(): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  try {
    return pidsDeTasklist(await ejecuta('tasklist', ['/FI', 'IMAGENAME eq Overwolf.exe', '/FO', 'CSV', '/NH']));
  } catch {
    return [];
  }
}

export async function cierraProceso(pid: number): Promise<boolean> {
  try {
    await ejecuta('taskkill', ['/PID', String(pid), '/F']);
    return true;
  } catch {
    return false;
  }
}
