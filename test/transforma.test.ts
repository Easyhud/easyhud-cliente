/**
 * Tablas A–E: de lo que manda GEP a lo que lee el servidor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analiza,
  codigoMapa,
  habilidades,
  informeRonda,
  killfeed,
  marcador,
  marcadorCompanero,
  marcadorVacio,
  partirNombre,
  roster,
} from '../src/principal/gep/transforma.ts';

const CRUDO_MARCADOR = {
  name: 'Nombre #TAG',
  player_id: 'puuid-1',
  team: 1,
  character: 'Wushu',
  alive: true,
  armor: 50,
  weapon: 'Vandal',
  ult_points: 3,
  ult_max: 7,
  spike: 'TX_Hud_Bomb_S',
  money: 3900,
  kills: 12,
  deaths: 7,
  assists: 4,
};

test('tabla A: marcador completo', () => {
  assert.deepEqual(marcador(CRUDO_MARCADOR), {
    name: 'Nombre',
    tagline: 'TAG',
    playerId: 'puuid-1',
    startTeam: 1,
    agentInternal: 'Wushu',
    isAlive: true,
    initialArmor: 50,
    scoreboardWeaponInternal: 'Vandal',
    currUltPoints: 3,
    maxUltPoints: 7,
    hasSpike: true,
    money: 3900,
    kills: 12,
    deaths: 7,
    assists: 4,
  });
});

test('tabla A: armor/shield según versión de GEP, spike booleano o textual', () => {
  const { armor: _a, ...sinArmor } = CRUDO_MARCADOR;
  assert.equal(marcador({ ...sinArmor, shield: 25 }).initialArmor, 25);
  assert.equal(marcador({ ...CRUDO_MARCADOR, spike: false }).hasSpike, false);
  assert.equal(marcador({ ...CRUDO_MARCADOR, spike: true }).hasSpike, true);
  assert.equal(marcador({ ...CRUDO_MARCADOR, spike: 'otra cosa' }).hasSpike, false);
});

test('nombres: sin " #" la tagline queda indefinida (marcador) o vacía (roster)', () => {
  assert.deepEqual(partirNombre('Solo'), { name: 'Solo', tagline: undefined });
  assert.deepEqual(partirNombre('Con espacio #EUW 2'), { name: 'Con espacio', tagline: 'EUW 2' });
  assert.equal(roster({ name: 'Solo', team: 0 }, 'roster_0').tagline, '');
});

test('tabla B: roster con posición desde la clave', () => {
  assert.deepEqual(
    roster({ name: 'A #B', team: 0, character: 'Clay', player_id: 'p', locked: true, rank: 0 }, 'roster_3'),
    { name: 'A', tagline: 'B', startTeam: 0, agentInternal: 'Clay', playerId: 'p', position: 3, locked: true, rank: 0 },
  );
});

test('tabla C: killfeed con asistencias no vacías en orden', () => {
  assert.deepEqual(
    killfeed({
      attacker: 'A',
      victim: 'V',
      weapon: 'TX_Killfeed_Vandal',
      headshot: true,
      assist1: 'X',
      assist2: '',
      assist3: 'Y',
      is_victim_teammate: false,
    }),
    { attacker: 'A', victim: 'V', weaponKillfeedInternal: 'TX_Killfeed_Vandal', headshotKill: true, assists: ['X', 'Y'], isTeamkill: false },
  );
});

test('tabla D: marcador de compañero sin nombre ni equipo', () => {
  const c = marcadorCompanero(CRUDO_MARCADOR);
  assert.equal('name' in c, false);
  assert.equal('startTeam' in c, false);
  assert.equal(c.playerId, 'puuid-1');
  assert.equal(c.money, 3900);
});

test('tabla E: informe de ronda numérico, no numérico = 0', () => {
  assert.deepEqual(
    informeRonda({
      damage: '150',
      damage_received: 40,
      hit: '5',
      headshot: '2',
      bodyshots: 'x',
      legshots: null,
      final_headshot: '1',
      ability_damage: 12,
    }),
    { damage: 150, damageReceived: 40, hits: 5, headshots: 2, bodyshots: 0, legshots: 0, finalHeadshot: true, abilityDamage: 12 },
  );
  assert.equal(informeRonda({ final_headshot: '0' }).finalHeadshot, false);
});

test('habilidades y utilidades', () => {
  assert.deepEqual(habilidades({ C: 1, Q: 2, E: 0, X: 5 }), { grenade: 1, ability_1: 2, ability_2: 0, ultimate: 5 });
  assert.equal(codigoMapa('Infinity'), 'Infinityy');
  assert.equal(codigoMapa('Ascent'), 'Ascent');
  assert.deepEqual(analiza('{"a":1}'), { a: 1 });
  assert.equal(analiza('no json'), null);
  assert.equal(analiza('[1]'), null);
  for (const v of [null, undefined, 'open', 'closed', 'close']) assert.equal(marcadorVacio(v), true);
  assert.equal(marcadorVacio('{}'), false);
});
