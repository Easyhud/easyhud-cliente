/**
 * Rango competitivo (tier 0–27) por puuid.
 *
 * 1. API de Riot con el contexto local (`{pd}/mmr/v1/players/{puuid}`).
 * 2. Respaldo HenrikDev, SÓLO si hay clave en `HDEV_KEY`. No hay clave
 *    embebida en el binario: una clave embebida se consideraría
 *    comprometida en cuanto el código es público.
 *
 * Caché en memoria para toda la sesión (sólo aciertos) y una única petición
 * en vuelo por puuid.
 */

import type { ResolutorRiot } from './contexto.ts';
import { objeto, pide } from './peticion.ts';

const HENRIK = 'https://api.henrikdev.xyz/valorant';

export interface OpcionesRango {
  riot: ResolutorRiot;
  /** La clave de HenrikDev; vacía = sin respaldo. */
  claveHenrik?: string;
  log?: (texto: string) => void;
}

export class Rangos {
  private readonly cache = new Map<string, number>();
  private readonly enCurso = new Map<string, Promise<number | undefined>>();
  private readonly regiones = new Map<string, string>();
  private readonly o: OpcionesRango;

  constructor(opciones: OpcionesRango) {
    this.o = opciones;
  }

  enCache(puuid: string): number | undefined {
    return this.cache.get(puuid);
  }

  resuelve(puuid: string): Promise<number | undefined> {
    const conocido = this.cache.get(puuid);
    if (conocido !== undefined) return Promise.resolve(conocido);
    let p = this.enCurso.get(puuid);
    if (p === undefined) {
      p = this.busca(puuid)
        .catch(() => undefined)
        .then((r) => {
          this.enCurso.delete(puuid);
          if (r !== undefined) this.cache.set(puuid, r);
          return r;
        });
      this.enCurso.set(puuid, p);
    }
    return p;
  }

  private async busca(puuid: string): Promise<number | undefined> {
    const local = await this.porRiot(puuid).catch(() => undefined);
    if (local !== undefined) return local;
    return this.porHenrik(puuid).catch(() => undefined);
  }

  private async porRiot(puuid: string): Promise<number | undefined> {
    const c = await this.o.riot.contexto();
    if (c === null || c.pd === '') return undefined;
    if (c.region !== '') this.regiones.set(puuid, c.region);
    const r = await pide(`${c.pd}/mmr/v1/players/${encodeURIComponent(puuid)}`, { cabeceras: c.cabeceras });
    if (r.estado === 401 || r.estado === 403) this.o.riot.olvida();
    if (r.estado !== 200) return undefined;
    const tier = objeto(objeto(r.json()).LatestCompetitiveUpdate).TierAfterUpdate;
    return typeof tier === 'number' && tier > 0 ? tier : undefined;
  }

  private async porHenrik(puuid: string): Promise<number | undefined> {
    const clave = this.o.claveHenrik ?? '';
    if (clave === '') return undefined;
    const cabeceras = { Authorization: clave };
    let region = this.regiones.get(puuid) ?? '';
    if (region === '') {
      const r = await pide(`${HENRIK}/v1/by-puuid/account/${encodeURIComponent(puuid)}`, { cabeceras });
      const reg = objeto(objeto(r.json()).data).region;
      if (typeof reg !== 'string' || reg === '') return undefined;
      region = reg;
      this.regiones.set(puuid, region);
    }
    const r = await pide(`${HENRIK}/v2/by-puuid/mmr/${encodeURIComponent(region)}/${encodeURIComponent(puuid)}`, { cabeceras });
    const tier = objeto(objeto(objeto(r.json()).data).current_data).currenttier;
    return typeof tier === 'number' ? tier : undefined;
  }
}
