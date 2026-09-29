/**
 * Procesos que se quedaron colgados de una ejecución anterior de Easy HUD.
 *
 * Síntoma que reportó el operador: GEP no llega a "Ready" (o abrir la app no
 * hace nada) hasta que mata el proceso a mano. Un proceso principal viejo de
 * Easy HUD sigue vivo (oculto, sin ventana, o colgado) y retiene el candado de
 * instancia única y los paquetes de Overwolf.
 *
 * Qué cuenta como resto: un proceso con el MISMO ejecutable que éste, que sea
 * un proceso principal de Electron (su línea de órdenes no lleva `--type=`,
 * que es lo que llevan los hijos: renderer, gpu, utility…), que no sea éste y
 * que sea del mismo rol (el jugador `--auxiliary` y el observador pueden
 * convivir en la misma PC, cada uno con su candado).
 */

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export interface Proceso {
  pid: number;
  padre: number;
  ruta: string;
  orden: string;
}

function ejecuta(programa: string, args: string[], esperaMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(programa, args, { windowsHide: true, timeout: esperaMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) =>
      e ? reject(e) : resolve(stdout),
    );
  });
}

/** Lee la salida JSON de `Get-CimInstance Win32_Process | Select … | ConvertTo-Json`. */
export function leeListaProcesos(json: string): Proceso[] {
  let datos: unknown;
  try {
    datos = JSON.parse(json.trim() === '' ? '[]' : json);
  } catch {
    return [];
  }
  const lista = Array.isArray(datos) ? datos : [datos];
  const salida: Proceso[] = [];
  for (const d of lista) {
    if (typeof d !== 'object' || d === null) continue;
    const o = d as Record<string, unknown>;
    const pid = Number(o.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    salida.push({
      pid,
      padre: Number(o.ParentProcessId) || 0,
      ruta: typeof o.ExecutablePath === 'string' ? o.ExecutablePath : '',
      orden: typeof o.CommandLine === 'string' ? o.CommandLine : '',
    });
  }
  return salida;
}

export interface Yo {
  pid: number;
  /** `process.execPath`. */
  ejecutable: string;
  /** Si este proceso es el jugador (`--auxiliary`). */
  auxiliar: boolean;
}

const mismaRuta = (a: string, b: string) => a !== '' && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

/** Los procesos principales de Easy HUD que no son éste (función pura). */
export function restosDe(lista: Proceso[], yo: Yo): Proceso[] {
  return lista.filter(
    (p) =>
      p.pid !== yo.pid &&
      mismaRuta(p.ruta, yo.ejecutable) &&
      !/(^|\s)--type=/.test(p.orden) &&
      /(^|\s)--auxiliary(\s|$)/.test(p.orden) === yo.auxiliar,
  );
}

/** Los procesos con ese nombre de ejecutable (sólo Windows; en otro sistema, ninguno). */
export async function procesosDe(nombreExe: string): Promise<Proceso[]> {
  if (process.platform !== 'win32') return [];
  const nombre = nombreExe.replace(/'/g, "''");
  const orden =
    `Get-CimInstance Win32_Process -Filter "Name='${nombre}'" | ` +
    'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  try {
    return leeListaProcesos(await ejecuta('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', orden]));
  } catch {
    return [];
  }
}

/** Restos de una ejecución anterior de Easy HUD (mismo exe y rol). */
export async function buscaRestos(yo: Yo): Promise<Proceso[]> {
  return restosDe(await procesosDe(basename(yo.ejecutable)), yo);
}

/** ¿Hay un proceso de VALORANT abierto? */
export async function valorantAbierto(): Promise<boolean> {
  return (await procesosDe('VALORANT-Win64-Shipping.exe')).length > 0;
}

/** ¿Sigue vivo ese PID? */
export function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Cierra el proceso y todos sus hijos (`taskkill /T /F`). */
export async function cierraArbol(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
  try {
    await ejecuta('taskkill', ['/PID', String(pid), '/T', '/F']);
    return true;
  } catch {
    return !vivo(pid);
  }
}
