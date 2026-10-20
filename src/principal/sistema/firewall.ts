/**
 * El Firewall de Windows: ¿tiene Easy HUD permiso de red? y, si no, pedirlo.
 *
 * El programa sólo hace conexiones salientes (al servidor) y las de la cámara (WebRTC). Casi siempre
 * Windows las deja pasar, pero un cortafuegos más estricto (o uno de un antivirus) puede cortarlas. Si la
 * autoprueba de red dice que el puerto no responde, se OFRECE al jugador crear las reglas de entrada y
 * salida del programa. Crear una regla exige permisos de administrador: se lanza `netsh` elevado, y
 * Windows enseña su propio aviso de permisos; el programa nunca se eleva por su cuenta ni lo hace sin
 * que el jugador lo acepte.
 */

import { execFile } from 'node:child_process';

export const NOMBRE_REGLA = 'Easy HUD';

function ejecuta(programa: string, args: string[], esperaMs: number): Promise<{ codigo: number; salida: string }> {
  return new Promise((resolve) => {
    execFile(programa, args, { windowsHide: true, timeout: esperaMs, maxBuffer: 1024 * 1024 }, (e, stdout) => {
      const codigo = e === null ? 0 : typeof (e as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1;
      resolve({ codigo, salida: String(stdout ?? '') });
    });
  });
}

/** ¿Hay alguna regla del Firewall con el nombre de Easy HUD? (no hace falta ser administrador para leerlo) */
export async function reglaExiste(): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const r = await ejecuta('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${NOMBRE_REGLA}`], 8000);
  return r.codigo === 0 && !/No rules match|Ninguna regla/i.test(r.salida);
}

/**
 * El guion de PowerShell que borra las reglas viejas y crea las nuevas (entrada y salida) para este
 * ejecutable. Se pasa codificado (`-EncodedCommand`) para no pelear con las comillas. Puro: se prueba.
 */
export function guionReglas(ejecutable: string): string {
  const exe = ejecutable.replace(/'/g, "''");
  return [
    `$ErrorActionPreference = 'Stop'`,
    `netsh advfirewall firewall delete rule name='${NOMBRE_REGLA}' | Out-Null`,
    `netsh advfirewall firewall add rule name='${NOMBRE_REGLA}' dir=out action=allow program='${exe}' enable=yes profile=any | Out-Null`,
    `netsh advfirewall firewall add rule name='${NOMBRE_REGLA}' dir=in action=allow program='${exe}' enable=yes profile=any | Out-Null`,
  ].join('\n');
}

/** El mismo guion como argumentos de `powershell.exe` para lanzarlo elevado (el aviso de Windows lo muestra el sistema). */
export function argumentosElevados(ejecutable: string): string[] {
  const codificado = Buffer.from(guionReglas(ejecutable), 'utf16le').toString('base64');
  const interior = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${codificado}`;
  const externo = `Start-Process -FilePath powershell.exe -ArgumentList '${interior}' -Verb RunAs -WindowStyle Hidden -Wait`;
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', externo];
}

export interface ResultadoRegla {
  ok: boolean;
  /** Qué pasó, para enseñarlo. */
  motivo: string;
}

/** Pide las reglas. Si el jugador rechaza el aviso de permisos de Windows, no se crea nada. */
export async function pideRegla(ejecutable: string): Promise<ResultadoRegla> {
  if (process.platform !== 'win32') return { ok: true, motivo: 'not needed on this system' };
  const r = await ejecuta('powershell.exe', argumentosElevados(ejecutable), 120_000);
  if (r.codigo !== 0) return { ok: false, motivo: 'the permission request was cancelled or failed' };
  const existe = await reglaExiste();
  return existe ? { ok: true, motivo: 'allowed in the Windows Firewall' } : { ok: false, motivo: 'the rule could not be created' };
}
