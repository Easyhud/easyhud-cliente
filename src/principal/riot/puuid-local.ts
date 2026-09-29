/**
 * El puuid del jugador sin esperar a GEP (presencia).
 *
 * Antes la presencia sólo latía cuando GEP había dado el puuid, que en un
 * jugador nuevo no pasa hasta su primera partida: el panel lo marcaba "No app"
 * aunque tuviera el programa abierto en el menú. El cliente de Riot local ya
 * lo sabe desde que el jugador inicia sesión: `GET /entitlements/v1/token`
 * sobre 127.0.0.1 con la contraseña del lockfile devuelve `subject` = puuid.
 *
 * Sólo se usa esa petición LOCAL (no se habla con los servidores de Riot ni
 * con valorant-api.com). Si el cliente de Riot no está abierto, no hay dato y
 * se sigue con el puuid de GEP/guardado.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { leeLockfile } from './contexto.ts';
import { objeto, pide } from './peticion.ts';

/** El puuid de la sesión abierta en el cliente de Riot local, o `''`. */
export async function leePuuidLocal(localAppData = process.env.LOCALAPPDATA ?? ''): Promise<string> {
  if (localAppData === '') return '';
  try {
    const bloqueo = leeLockfile(await readFile(join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile'), 'utf8'));
    if (bloqueo === null) return '';
    const auth = Buffer.from(`riot:${bloqueo.clave}`).toString('base64');
    const r = await pide(`${bloqueo.protocolo}://127.0.0.1:${bloqueo.puerto}/entitlements/v1/token`, {
      cabeceras: { Authorization: `Basic ${auth}` },
      inseguro: true,
      esperaMs: 3000,
    });
    if (r.estado !== 200) return '';
    const subject = objeto(r.json()).subject;
    return typeof subject === 'string' ? subject : '';
  } catch {
    return '';
  }
}

export interface OpcionesFuentePuuid {
  /** Lector del cliente de Riot local (en pruebas, uno falso). */
  lee: () => Promise<string>;
  /** Lo que se sabe por GEP o por disco. */
  respaldo: () => string;
  /** El puuid efectivo cambió (para latir en el acto y guardarlo). */
  alCambiar: (puuid: string) => void;
  /** Sondeo mientras no se conoce por Riot (por defecto 10 s). */
  periodoMs?: number;
  /** Sondeo una vez conocido, por si cambia de cuenta (por defecto 60 s). */
  periodoConocidoMs?: number;
}

/**
 * El puuid efectivo del jugador: el de la sesión del cliente de Riot si se
 * conoce (es la cuenta con la que está ahora), si no el de GEP o el guardado.
 */
export class FuentePuuid {
  private deRiot = '';
  private reloj: NodeJS.Timeout | null = null;
  private activo = false;
  private ultimo = '';
  private readonly o: OpcionesFuentePuuid;

  constructor(o: OpcionesFuentePuuid) {
    this.o = o;
  }

  actual(): string {
    return this.deRiot || this.o.respaldo();
  }

  /** Arranca con una lectura inmediata. */
  arranca(): void {
    if (this.activo) return;
    this.activo = true;
    this.ultimo = this.actual();
    void this.sondea();
  }

  /** Una lectura ahora (público para las pruebas). */
  async sondea(): Promise<void> {
    let leido = '';
    try {
      leido = await this.o.lee();
    } catch {
      leido = '';
    }
    // Riot cerrado después de conocerlo: se conserva el último (el programa sigue abierto).
    if (leido !== '') this.deRiot = leido;
    this.avisaSiCambio();
    if (this.reloj !== null) clearTimeout(this.reloj);
    this.reloj = null;
    if (!this.activo) return;
    const periodo = this.deRiot !== '' ? (this.o.periodoConocidoMs ?? 60_000) : (this.o.periodoMs ?? 10_000);
    this.reloj = setTimeout(() => void this.sondea(), periodo);
    this.reloj.unref?.();
  }

  /** El respaldo (GEP) pudo cambiar: se comprueba sin esperar al sondeo. */
  avisaSiCambio(): void {
    const ahora = this.actual();
    if (ahora !== this.ultimo) {
      this.ultimo = ahora;
      if (ahora !== '') this.o.alCambiar(ahora);
    }
  }

  para(): void {
    this.activo = false;
    if (this.reloj !== null) clearTimeout(this.reloj);
    this.reloj = null;
  }
}
