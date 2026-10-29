/**
 * Almacén clave → fichero JSON.
 *
 * Formato en disco estable: carpeta `storage` dentro del directorio de datos
 * de usuario y un fichero `<clave>.json` por clave, con el valor serializado
 * tal cual. Una clave que no existe (o que no se puede leer) se lee como
 * objeto vacío.
 *
 * Lectura síncrona; escritura atómica (fichero temporal + renombrado) y en
 * cola por clave, para que dos guardados seguidos no se pisen a medias.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Las claves que existen. */
export const CLAVES = {
  bandeja: 'traySetting',
  ventana: 'windowState',
  inicio: 'startupSettings',
  secreto: 'matchSecret',
  puuid: 'playerId',
  matchId: 'matchId',
} as const;

export interface FormaClaves {
  traySetting: { traySetting?: boolean };
  windowState: { bounds?: { x: number; y: number; width: number; height: number } };
  startupSettings: { enabled?: boolean; startMinimized?: boolean; aux?: boolean };
  matchSecret: { secret?: string; endTime?: number };
  playerId: { playerId?: string };
  matchId: { matchId?: string; timestamp?: number };
  /** Cámara del jugador: parte del nombre de la webcam a usar (vacío = la predeterminada). */
  camara: { dispositivo?: string };
  /** El grupo al que lo llamó el operador: si cierra y abre el programa, vuelve a entrar solo. */
  grupoJugador: { grupo?: string; desde?: number };
  /** El jugador ya vio la ventana de bienvenida (la primera vez se abre sola y se queda visible). */
  bienvenida: { vista?: boolean; version?: string };
}

/** Nombre de fichero de una clave (estable para claves ASCII). */
function nombreFichero(clave: string): string {
  return `${encodeURIComponent(clave).replace(/\*/g, '-')}.json`;
}

export class Almacen {
  readonly carpeta: string;
  private readonly colas = new Map<string, Promise<void>>();

  constructor(directorioDatos: string) {
    this.carpeta = join(directorioDatos, 'storage');
  }

  ruta(clave: string): string {
    return join(this.carpeta, nombreFichero(clave));
  }

  lee<K extends keyof FormaClaves>(clave: K): FormaClaves[K];
  lee(clave: string): Record<string, unknown>;
  lee(clave: string): Record<string, unknown> {
    try {
      const v: unknown = JSON.parse(readFileSync(this.ruta(clave), 'utf8'));
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Guarda el valor; la promesa se resuelve cuando está en disco. */
  escribe<K extends keyof FormaClaves>(clave: K, valor: FormaClaves[K]): Promise<void>;
  escribe(clave: string, valor: unknown): Promise<void>;
  escribe(clave: string, valor: unknown): Promise<void> {
    const texto = JSON.stringify(valor);
    const anterior = this.colas.get(clave) ?? Promise.resolve();
    const siguiente = anterior.then(() => {
      mkdirSync(this.carpeta, { recursive: true });
      const destino = this.ruta(clave);
      const temporal = `${destino}.${process.pid}.tmp`;
      writeFileSync(temporal, texto);
      renameSync(temporal, destino);
    });
    // La cola no debe quedarse rota por un fallo: el siguiente guardado lo reintenta.
    this.colas.set(
      clave,
      siguiente.catch(() => undefined),
    );
    return siguiente;
  }

  borra(clave: string): void {
    rmSync(this.ruta(clave), { force: true });
  }

  /**
   * Tras un cierre brusco (apagón, proceso matado) pueden quedar ficheros `*.tmp` a medio escribir. No
   * estorban (la lectura nunca los mira: el fichero bueno se sustituye por renombrado atómico), pero se
   * borran al arrancar para que no se acumulen. Devuelve cuántos quitó.
   */
  limpiaTemporales(): number {
    let n = 0;
    try {
      for (const f of readdirSync(this.carpeta)) {
        if (!f.endsWith('.tmp')) continue;
        try {
          rmSync(join(this.carpeta, f), { force: true });
          n += 1;
        } catch {
          // Lo tiene otro proceso: se queda para la próxima.
        }
      }
    } catch {
      // Sin carpeta aún: nada que limpiar.
    }
    return n;
  }
}
