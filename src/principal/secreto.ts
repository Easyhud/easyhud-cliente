/**
 * Lo que se recuerda entre conexiones y reinicios:
 *
 *   · el secreto de reconexión del observador (`matchSecret`), 2 h;
 *   · el último matchId del jugador (`matchId`), 2 h;
 *   · el puuid del jugador (`playerId`), sin caducidad.
 *
 * El token de emisión NO está aquí: vive sólo en memoria.
 */

import type { Almacen } from './almacen.ts';

export const VIGENCIA_MS = 2 * 60 * 60 * 1000;

export class Recuerdos {
  private readonly almacen: Almacen;
  private readonly reloj: () => number;
  /** El secreto recordado en memoria (se re-persiste en cada `match_start`). */
  private secreto: { secret: string; endTime: number } | null = null;

  constructor(almacen: Almacen, reloj: () => number = Date.now) {
    this.almacen = almacen;
    this.reloj = reloj;
  }

  /** El secreto vigente, o `''`. Uno caducado se borra al leerlo. */
  secretoVigente(): string {
    const guardado = this.almacen.lee('matchSecret');
    if (typeof guardado.secret !== 'string' || guardado.secret === '') return '';
    if (typeof guardado.endTime !== 'number' || guardado.endTime <= this.reloj()) {
      this.almacen.borra('matchSecret');
      return '';
    }
    return guardado.secret;
  }

  async recuerdaSecreto(secret: string): Promise<void> {
    this.secreto = { secret, endTime: this.reloj() + VIGENCIA_MS };
    await this.almacen.escribe('matchSecret', this.secreto);
  }

  /** En cada `match_start`: vuelve a guardar el secreto recordado, con su misma caducidad. */
  async repersisteSecreto(): Promise<void> {
    if (this.secreto === null) return;
    await this.almacen.escribe('matchSecret', this.secreto);
  }

  puuid(): string {
    const p = this.almacen.lee('playerId').playerId;
    return typeof p === 'string' ? p : '';
  }

  guardaPuuid(playerId: string): Promise<void> {
    return this.almacen.escribe('playerId', { playerId });
  }

  matchIdVigente(): string {
    const m = this.almacen.lee('matchId');
    if (typeof m.matchId !== 'string' || m.matchId === '') return '';
    if (typeof m.timestamp !== 'number' || this.reloj() - m.timestamp > VIGENCIA_MS) return '';
    return m.matchId;
  }

  guardaMatchId(matchId: string): Promise<void> {
    return this.almacen.escribe('matchId', { matchId, timestamp: this.reloj() });
  }
}
