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

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
}
