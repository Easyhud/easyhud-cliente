/**
 * Las transformaciones de GEP a los tipos que entiende el servidor.
 *
 * Funciones puras, sin estado: reciben el objeto que GEP manda (ya analizado)
 * y devuelven el que viaja por `obs_data`/`aux_data`. Los nombres de campo de
 * salida son contrato con `servidor-v2` (su reductor los lee tal cual).
 *
 * Tablas A–E de la especificación §2.2 y §2.4.
 */

export type Crudo = Record<string, unknown>;

/** GEP manda casi todo como texto con JSON dentro; a veces ya como objeto. */
export function analiza(valor: unknown): Crudo | null {
  if (typeof valor === 'object' && valor !== null && !Array.isArray(valor)) return valor as Crudo;
  if (typeof valor !== 'string') return null;
  try {
    const v: unknown = JSON.parse(valor);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Crudo) : null;
  } catch {
    return null;
  }
}

/** `Nombre #TAG` → nombre y tagline. Sin ` #`, tagline indefinido. */
export function partirNombre(completo: unknown): { name: string; tagline: string | undefined } {
  const texto = typeof completo === 'string' ? completo : String(completo ?? '');
  const i = texto.indexOf(' #');
  if (i === -1) return { name: texto, tagline: undefined };
  return { name: texto.slice(0, i), tagline: texto.slice(i + 2) };
}

/** Un marcador que no trae datos: GEP manda `open`/`closed`/`close` al abrir/cerrar la tabla. */
export function marcadorVacio(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === 'open' || valor === 'closed' || valor === 'close';
}

function tieneSpike(spike: unknown): boolean {
  return typeof spike === 'boolean' ? spike : spike === 'TX_Hud_Bomb_S';
}

/** Tabla D: la parte del marcador que no depende del nombre ni del equipo. */
export function marcadorCompanero(g: Crudo) {
  return {
    playerId: g.player_id,
    agentInternal: g.character,
    isAlive: g.alive,
    // `armor` en GEP reciente, `shield` en versiones viejas.
    initialArmor: 'armor' in g ? g.armor : g.shield,
    scoreboardWeaponInternal: g.weapon,
    currUltPoints: g.ult_points,
    maxUltPoints: g.ult_max,
    hasSpike: tieneSpike(g.spike),
    money: g.money,
    kills: g.kills,
    deaths: g.deaths,
    assists: g.assists,
  };
}

/** Tabla A: marcador (`scoreboard` del observador y `aux_scoreboard` del jugador). */
export function marcador(g: Crudo) {
  const { name, tagline } = partirNombre(g.name);
  const { playerId, ...resto } = marcadorCompanero(g);
  return { name, tagline, playerId, startTeam: g.team, ...resto };
}

export type Marcador = ReturnType<typeof marcador>;

/** Tabla B: roster. `clave` es la de GEP (`roster_3` → posición 3). */
export function roster(g: Crudo, clave: string) {
  const { name, tagline } = partirNombre(g.name);
  const posicion = Number(clave.slice(clave.lastIndexOf('_') + 1));
  return {
    name,
    tagline: tagline ?? '',
    startTeam: g.team,
    agentInternal: g.character,
    playerId: g.player_id,
    position: Number.isFinite(posicion) ? posicion : 0,
    locked: g.locked,
    rank: g.rank,
  };
}

export type Roster = ReturnType<typeof roster>;

/** Tabla C: killfeed. */
export function killfeed(g: Crudo) {
  const asistencias = [g.assist1, g.assist2, g.assist3, g.assist4].filter(
    (a) => a !== undefined && a !== null && a !== '',
  );
  return {
    attacker: g.attacker,
    victim: g.victim,
    weaponKillfeedInternal: g.weapon,
    headshotKill: g.headshot,
    assists: asistencias,
    isTeamkill: g.is_victim_teammate,
  };
}

const numero = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Tabla E: informe de ronda del jugador. */
export function informeRonda(g: Crudo) {
  return {
    damage: numero(g.damage),
    damageReceived: numero(g.damage_received),
    hits: numero(g.hit),
    headshots: numero(g.headshot),
    bodyshots: numero(g.bodyshots),
    legshots: numero(g.legshots),
    finalHeadshot: Boolean(numero(g.final_headshot)),
    abilityDamage: numero(g.ability_damage),
  };
}

/** Cargas de habilidad del jugador (`C`, `Q`, `E`, `X`). */
export function habilidades(g: Crudo) {
  return { grenade: g.C, ability_1: g.Q, ability_2: g.E, ultimate: g.X };
}

/** El servidor no admite `Infinity` como código de mapa (Abyss). */
export function codigoMapa(valor: string): string {
  return valor === 'Infinity' ? 'Infinityy' : valor;
}
