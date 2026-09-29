/**
 * Perfil de compilación: qué exe es éste (normal, observador fijo o jugador).
 *
 * El perfil se "quema" en el paquete: el script de build escribe
 * `app/perfil.json` DESPUÉS de compilar, dentro de la salida (que acaba en el
 * asar). El código fuente no se reescribe nunca, así que un build a medias no
 * deja el proyecto con otro perfil.
 * Sin ese fichero (arranque de desarrollo) el perfil es `normal`.
 *
 * El objeto se entrega tal cual al panel (`get-build-profile`), que sólo mira
 * `mode`. `lockConnection` no lo usa nadie, pero es parte de la forma.
 */

import { readFileSync } from 'node:fs';

export type Modo = 'normal' | 'player' | 'observer';

export interface Perfil {
  mode: Modo;
  ingestIp: string | null;
  lockConnection: boolean;
  forceAutostart: boolean;
  forceTray: boolean;
  startHidden: boolean;
}

export type Rol = 'observador' | 'jugador';

/** La IP de ingesta de producción (también la de los builds fijos). */
export const INGESTA_POR_DEFECTO = 'http://2.24.200.205:5100';

export const MODOS: readonly Modo[] = ['normal', 'player', 'observer'];

/** Los valores de cada perfil. `normal` ignora la IP. */
export function perfilPara(modo: Modo, ip: string | null = null): Perfil {
  switch (modo) {
    case 'normal':
      return { mode: 'normal', ingestIp: null, lockConnection: false, forceAutostart: false, forceTray: false, startHidden: false };
    case 'observer':
      return { mode: 'observer', ingestIp: ip, lockConnection: true, forceAutostart: false, forceTray: true, startHidden: false };
    case 'player':
      return { mode: 'player', ingestIp: ip, lockConnection: true, forceAutostart: true, forceTray: true, startHidden: true };
  }
}

function esPerfil(v: unknown): v is Perfil {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.mode === 'string' &&
    (MODOS as readonly string[]).includes(p.mode) &&
    (p.ingestIp === null || typeof p.ingestIp === 'string') &&
    ['lockConnection', 'forceAutostart', 'forceTray', 'startHidden'].every((k) => typeof p[k] === 'boolean')
  );
}

/** Lee el perfil quemado junto a la salida compilada; sin él, `normal`. */
export function cargaPerfil(ruta: URL = new URL('../perfil.json', import.meta.url)): Perfil {
  try {
    const leido: unknown = JSON.parse(readFileSync(ruta, 'utf8'));
    if (esPerfil(leido)) return leido;
  } catch {
    // Sin fichero: arranque de desarrollo.
  }
  return perfilPara('normal');
}

/** `player` siempre jugador; `observer` siempre observador; `normal` según `--auxiliary`. */
export function rolEfectivo(perfil: Perfil, argv: readonly string[]): Rol {
  if (perfil.mode === 'player') return 'jugador';
  if (perfil.mode === 'observer') return 'observador';
  return argv.includes('--auxiliary') ? 'jugador' : 'observador';
}
