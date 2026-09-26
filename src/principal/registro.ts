/**
 * Registro a fichero: una línea por suceso, con hora ISO.
 *
 * Sin librería. Se escribe en `<carpeta de logs>/main.log`; al pasar de 2 MiB
 * se rota a `main.old.log` (se conserva uno). Hasta que se configura la ruta,
 * sólo va a la consola, que es lo que pasa en las pruebas.
 *
 * Regla: el token de emisión nunca se escribe entero. Quien loguee algo que
 * pueda llevarlo usa `recorta()`.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOPE_BYTES = 2 * 1024 * 1024;

let fichero: string | null = null;
let silencio = false;

/** Las pruebas lo callan para no ensuciar la salida de `node --test`. */
export function silencia(si: boolean): void {
  silencio = si;
}

export function configuraRegistro(carpeta: string): string {
  mkdirSync(carpeta, { recursive: true });
  fichero = join(carpeta, 'main.log');
  return fichero;
}

function rota(ruta: string): void {
  try {
    if (existsSync(ruta) && statSync(ruta).size > TOPE_BYTES) {
      renameSync(ruta, join(dirname(ruta), 'main.old.log'));
    }
  } catch {
    // Si no se puede rotar se sigue escribiendo en el mismo: mejor largo que mudo.
  }
}

function escribe(nivel: string, texto: string): void {
  const linea = `[${new Date().toISOString()}] ${nivel} ${texto}\n`;
  if (!silencio) process.stdout.write(linea);
  if (fichero === null) return;
  try {
    rota(fichero);
    appendFileSync(fichero, linea);
  } catch {
    // El log nunca debe tumbar el programa.
  }
}

export function log(texto: string): void {
  escribe('info ', texto);
}

export function aviso(texto: string): void {
  escribe('warn ', texto);
}

export function error(texto: string, e?: unknown): void {
  const detalle = e instanceof Error ? ` — ${e.stack ?? e.message}` : e !== undefined ? ` — ${String(e)}` : '';
  escribe('error', `${texto}${detalle}`);
}

/** Un secreto en el log: sólo el principio, para poder distinguir uno de otro. */
export function recorta(secreto: string | null | undefined): string {
  if (!secreto) return '(vacío)';
  return secreto.length <= 8 ? '***' : `${secreto.slice(0, 6)}…(${secreto.length})`;
}

/** Captura lo que se escape: se registra y el programa sigue. */
export function capturaErrores(): void {
  process.on('uncaughtException', (e) => error('excepción no controlada', e));
  process.on('unhandledRejection', (e) => error('promesa rechazada sin tratar', e));
}
