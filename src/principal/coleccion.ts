/**
 * La base local del operador: equipos, matches y torneos.
 *
 * Cada colección es una clave del almacén con forma `{items: [...]}`. El
 * programa no valida el esquema: guarda lo que manda el panel
 * (`overlay/panel/js/db.js` define la forma).
 *
 * La colección se carga una vez y se mantiene en memoria. Cada cambio se hace
 * sobre esa copia de forma síncrona y luego se guarda: así dos `create`
 * seguidos, sin esperar al primero, no pueden perder uno (que es lo que pasaría
 * releyendo de disco con un guardado aún en vuelo).
 */

import { randomUUID } from 'node:crypto';
import type { Almacen } from './almacen.ts';

export const COLECCIONES = { teams: 'db-teams', matches: 'db-matches', tournaments: 'db-tournaments' } as const;
export type NombreColeccion = keyof typeof COLECCIONES;

export type Registro = Record<string, unknown> & { id: string; createdAt: number; updatedAt: number };

export class Coleccion {
  private items: Registro[] | null = null;
  private readonly almacen: Almacen;
  readonly clave: string;
  private readonly reloj: () => number;

  constructor(almacen: Almacen, clave: string, reloj: () => number = Date.now) {
    this.almacen = almacen;
    this.clave = clave;
    this.reloj = reloj;
  }

  private cargados(): Registro[] {
    if (this.items === null) {
      const leido = this.almacen.lee(this.clave).items;
      this.items = Array.isArray(leido) ? (leido.filter((x) => typeof x === 'object' && x !== null) as Registro[]) : [];
    }
    return this.items;
  }

  private guarda(): Promise<void> {
    return this.almacen.escribe(this.clave, { items: this.cargados() });
  }

  /** Todos, en orden de creación. */
  list(): Registro[] {
    return [...this.cargados()];
  }

  async create(dato: unknown): Promise<Registro> {
    const ahora = this.reloj();
    const base = typeof dato === 'object' && dato !== null ? (dato as Record<string, unknown>) : {};
    const registro: Registro = { ...base, id: randomUUID(), createdAt: ahora, updatedAt: ahora };
    this.cargados().push(registro);
    await this.guarda();
    return registro;
  }

  /** Mezcla superficial; `id` y `createdAt` no se pisan. `null` si no existe. */
  async update(id: unknown, parche: unknown): Promise<Registro | null> {
    const items = this.cargados();
    const i = items.findIndex((x) => x.id === id);
    if (i === -1) return null;
    const p = typeof parche === 'object' && parche !== null ? (parche as Record<string, unknown>) : {};
    const actual = items[i];
    const nuevo: Registro = { ...actual, ...p, id: actual.id, createdAt: actual.createdAt, updatedAt: this.reloj() };
    items[i] = nuevo;
    await this.guarda();
    return nuevo;
  }

  /** `true` si borró algo. */
  async delete(id: unknown): Promise<boolean> {
    const items = this.cargados();
    const quedan = items.filter((x) => x.id !== id);
    if (quedan.length === items.length) return false;
    this.items = quedan;
    await this.guarda();
    return true;
  }
}

export function creaColecciones(almacen: Almacen): Record<NombreColeccion, Coleccion> {
  return {
    teams: new Coleccion(almacen, COLECCIONES.teams),
    matches: new Coleccion(almacen, COLECCIONES.matches),
    tournaments: new Coleccion(almacen, COLECCIONES.tournaments),
  };
}
