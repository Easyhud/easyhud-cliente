/**
 * Contexto del cliente de Riot local: lo necesario para hablar con su API y
 * con los servidores de partidas de Riot.
 *
 * ZONA GRIS: es la API local no oficial que usan los medidores de rango. No
 * está sancionada y puede romperse con cualquier parche. Sólo se usa detrás de
 * los interruptores beta del panel (sala, crear sala) y para el rango.
 *
 * El contexto se cachea 5 minutos y sólo si se obtuvo, así que si Riot no
 * está abierto se reintenta más adelante en vez de quedar el fallo cacheado
 * indefinidamente; los tokens se renuevan antes de caducar.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { objeto, pide } from './peticion.ts';

export interface ContextoRiot {
  puuid: string;
  /** `https://glz-<región>-1.<shard>.a.pvp.net`, o `''` si no se encontró. */
  glz: string;
  /** `https://pd.<shard>.a.pvp.net`, o `''`. */
  pd: string;
  region: string;
  cabeceras: Record<string, string>;
}

const VIGENCIA_MS = 5 * 60_000;

const PLATAFORMA = Buffer.from(
  JSON.stringify({
    platformType: 'PC',
    platformOS: 'Windows',
    platformOSVersion: '10.0.19042.1.256.64bit',
    platformChipset: 'Unknown',
  }),
).toString('base64');

/** `nombre:pid:puerto:contraseña:protocolo`. */
export function leeLockfile(texto: string): { puerto: string; clave: string; protocolo: string } | null {
  const partes = texto.trim().split(':');
  if (partes.length < 5) return null;
  return { puerto: partes[2], clave: partes[3], protocolo: partes[4] };
}

/** Las dos URLs de servidores de Riot que aparecen en el log de VALORANT. */
export function servidoresDelLog(texto: string): { glz: string; pd: string; region: string } {
  const glz = /https:\/\/glz-([a-z0-9]+)-1\.([a-z0-9]+)\.a\.pvp\.net/i.exec(texto);
  const pd = /https:\/\/pd\.([a-z0-9]+)\.a\.pvp\.net/i.exec(texto);
  return { glz: glz?.[0] ?? '', pd: pd?.[0] ?? '', region: glz?.[1] ?? '' };
}

export class ResolutorRiot {
  private cache: { valor: ContextoRiot; hasta: number } | null = null;
  private enCurso: Promise<ContextoRiot | null> | null = null;
  private versionCliente: string | null = null;
  private readonly localAppData: string;

  constructor(localAppData = process.env.LOCALAPPDATA ?? '') {
    this.localAppData = localAppData;
  }

  /** El contexto, o `null` si el cliente de Riot no está abierto o algo falla. */
  contexto(): Promise<ContextoRiot | null> {
    if (this.cache !== null && this.cache.hasta > Date.now()) return Promise.resolve(this.cache.valor);
    if (this.enCurso === null) {
      this.enCurso = this.resuelve()
        .catch(() => null)
        .then((c) => {
          this.enCurso = null;
          if (c !== null) this.cache = { valor: c, hasta: Date.now() + VIGENCIA_MS };
          return c;
        });
    }
    return this.enCurso;
  }

  /** Tras un 401/403 de Riot: los tokens están viejos. */
  olvida(): void {
    this.cache = null;
  }

  private async resuelve(): Promise<ContextoRiot | null> {
    if (this.localAppData === '') return null;
    let bloqueo: ReturnType<typeof leeLockfile>;
    try {
      bloqueo = leeLockfile(await readFile(join(this.localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile'), 'utf8'));
    } catch {
      return null;
    }
    if (bloqueo === null) return null;

    const auth = Buffer.from(`riot:${bloqueo.clave}`).toString('base64');
    const r = await pide(`${bloqueo.protocolo}://127.0.0.1:${bloqueo.puerto}/entitlements/v1/token`, {
      cabeceras: { Authorization: `Basic ${auth}` },
      inseguro: true,
    });
    if (r.estado !== 200) return null;
    const t = objeto(r.json());
    if (typeof t.subject !== 'string' || typeof t.accessToken !== 'string' || typeof t.token !== 'string') return null;

    let servidores = { glz: '', pd: '', region: '' };
    try {
      servidores = servidoresDelLog(await readFile(join(this.localAppData, 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log'), 'utf8'));
    } catch {
      // Sin log no hay servidores; el contexto sirve igual para saber el puuid.
    }

    return {
      puuid: t.subject,
      ...servidores,
      cabeceras: {
        Authorization: `Bearer ${t.accessToken}`,
        'X-Riot-Entitlements-JWT': t.token,
        'X-Riot-ClientPlatform': PLATAFORMA,
        'X-Riot-ClientVersion': await this.version(),
      },
    };
  }

  /** Versión del cliente de Riot, una vez por sesión (sólo si se obtuvo). */
  private async version(): Promise<string> {
    if (this.versionCliente !== null) return this.versionCliente;
    try {
      const r = await pide('https://valorant-api.com/v1/version');
      const v = objeto(objeto(r.json()).data).riotClientVersion;
      if (typeof v === 'string' && v !== '') this.versionCliente = v;
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  }
}
