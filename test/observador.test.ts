/**
 * Traductor del observador: de los datos de GEP a las acciones (envíos,
 * estados, fin de mapa…).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Accion } from '../src/principal/gep/acciones.ts';
import { TraductorObservador } from '../src/principal/gep/observador.ts';

const envios = (acciones: Accion[]) =>
  acciones.filter((a): a is Extract<Accion, { tipo: 'envia' }> => a.tipo === 'envia').map((a) => ({ type: a.type, data: a.data }));

const marcadorGep = (puuid: string, team: number | string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: `Jugador ${puuid} #TAG`,
    player_id: puuid,
    team,
    character: 'Wushu',
    alive: true,
    armor: 50,
    weapon: 'Vandal',
    ult_points: 1,
    ult_max: 7,
    spike: false,
    money: 800,
    kills: 3,
    deaths: 1,
    assists: 2,
    ...extra,
  });

test('scoreboard: ignora aperturas/cierres y marcadores sin nombre; manda la tabla A', () => {
  const t = new TraductorObservador();
  for (const v of [null, 'open', 'closed', 'close']) assert.deepEqual(t.info({ key: 'scoreboard_0', value: v }), []);
  assert.deepEqual(t.info({ key: 'scoreboard_0', value: '{"player_id":"x"}' }), []);
  const [envio] = envios(t.info({ key: 'scoreboard_3', value: marcadorGep('p1', 0) }));
  assert.equal(envio.type, 'scoreboard');
  assert.equal((envio.data as { playerId: string }).playerId, 'p1');
  assert.equal((envio.data as { name: string }).name, 'Jugador p1');
});

test('roster: rango en caché sustituye al de GEP; si no, se pide resolverlo', () => {
  const cache = new Map([['conocido', 18]]);
  const t = new TraductorObservador({ rangoEnCache: (p) => cache.get(p) });
  const roster = (puuid: string) => JSON.stringify({ name: 'A #B', team: 1, character: 'Clay', player_id: puuid, locked: true, rank: 0 });

  const conCache = t.info({ key: 'roster_2', value: roster('conocido') });
  assert.equal(conCache.length, 1);
  assert.deepEqual(envios(conCache)[0].data, {
    name: 'A',
    tagline: 'B',
    startTeam: 1,
    agentInternal: 'Clay',
    playerId: 'conocido',
    position: 2,
    locked: true,
    rank: 18,
  });

  const sinCache = t.info({ key: 'roster_7', value: roster('nuevo') });
  assert.equal(envios(sinCache)[0].type, 'roster');
  const pide = sinCache.find((a) => a.tipo === 'resuelveRango');
  assert.ok(pide && pide.tipo === 'resuelveRango');
  assert.equal(pide.roster.playerId, 'nuevo');
  assert.equal(pide.roster.position, 7);
});

test('killfeed, observing, spike, match_start', () => {
  const t = new TraductorObservador();
  const kf = envios(t.info({ key: 'kill_feed', value: JSON.stringify({ attacker: 'A', victim: 'V', weapon: 'W', headshot: false, assist1: 'Z', is_victim_teammate: false }) }));
  assert.deepEqual(kf, [
    { type: 'killfeed', data: { attacker: 'A', victim: 'V', weaponKillfeedInternal: 'W', headshotKill: false, assists: ['Z'], isTeamkill: false } },
  ]);
  assert.deepEqual(envios(t.info({ key: 'observing', value: 'Nombre #TAG' })), [{ type: 'observing', data: 'Nombre #TAG' }]);
  assert.equal(t.esObservador, true);

  t.info({ key: 'match_id', value: 'match-123' });
  const inicio = t.evento({ key: 'match_start', value: null });
  assert.deepEqual(envios(inicio), [{ type: 'match_start', data: 'match-123' }]);
  assert.ok(inicio.some((a) => a.tipo === 'persisteSecreto'));
  assert.ok(inicio.some((a) => a.tipo === 'estadoJuego' && a.mensaje === 'Game Started'));

  for (const k of ['spike_planted', 'spike_detonated', 'spike_defused']) {
    assert.deepEqual(envios(t.evento({ key: k, value: null })), [{ type: k, data: true }]);
  }
  assert.deepEqual(t.evento({ key: 'shop', value: null }), []);
});

test('round_phase: round_info con el último round_number y estado "Round N"', () => {
  const t = new TraductorObservador();
  t.info({ key: 'round_number', value: '4' });
  const a = t.info({ key: 'round_phase', value: 'combat' });
  assert.deepEqual(envios(a), [{ type: 'round_info', data: { roundNumber: 4, roundPhase: 'combat' } }]);
  assert.ok(a.some((x) => x.tipo === 'estadoJuego' && x.mensaje === 'Round 4'));
  assert.equal(t.faseActual, 'combat');
});

test('score, map (Infinity → Infinityy), game_mode', () => {
  const t = new TraductorObservador();
  assert.deepEqual(envios(t.info({ key: 'match_score', value: '{"team_0":3,"team_1":5}' })), [
    { type: 'score', data: { team_0: 3, team_1: 5 } },
  ]);
  assert.deepEqual(envios(t.info({ key: 'map', value: 'Infinity' })), [{ type: 'map', data: 'Infinityy' }]);
  assert.deepEqual(envios(t.info({ key: 'game_mode', value: '{"mode":"bomb","custom":true}' })), [{ type: 'game_mode', data: 'bomb' }]);
  assert.deepEqual(t.modoDeJuego, { modo: 'bomb', custom: true });
  assert.deepEqual(t.info({ key: 'game_mode', value: '{"custom":true}' }), []);
});

test('escena de selección de agentes dispara la conexión', () => {
  const t = new TraductorObservador();
  const a = t.info({ key: 'scene', value: 'CharacterSelectPersistentLevel' });
  assert.ok(a.some((x) => x.tipo === 'conecta'));
  assert.ok(a.some((x) => x.tipo === 'estadoJuego' && x.mensaje === 'Agent Select'));
});

test('game_end: serie-mapa-fin con marcador, mapa, matchId y roster; estado final "Game Ended"', () => {
  const t = new TraductorObservador();
  t.info({ key: 'map', value: 'Ascent' });
  t.info({ key: 'scene', value: 'Ascent' });
  t.info({ key: 'match_id', value: 'm-1' });
  t.info({ key: 'scoreboard_0', value: marcadorGep('a', 0, { kills: 20, deaths: 10, assists: 5 }) });
  t.info({ key: 'scoreboard_1', value: marcadorGep('b', 1) });
  t.info({ key: 'scoreboard_2', value: marcadorGep('c', '1') }); // GEP con el equipo como texto
  t.info({ key: 'match_score', value: '{"team_0":13,"team_1":11}' });
  t.info({ key: 'round_number', value: 24 });

  const a = t.info({ key: 'round_phase', value: 'game_end' });
  const fin = a.find((x) => x.tipo === 'finMapa');
  assert.ok(fin && fin.tipo === 'finMapa');
  assert.deepEqual(fin.datos, {
    ganador: 0,
    izq: 13,
    der: 11,
    map: 'Ascent',
    matchId: 'm-1',
    roster: [
      { name: 'Jugador a', tagline: 'TAG', team: 0, agentInternal: 'Wushu', kills: 20, deaths: 10, assists: 5 },
      { name: 'Jugador b', tagline: 'TAG', team: 1, agentInternal: 'Wushu', kills: 3, deaths: 1, assists: 2 },
      { name: 'Jugador c', tagline: 'TAG', team: 1, agentInternal: 'Wushu', kills: 3, deaths: 1, assists: 2 },
    ],
  });
  assert.ok(a.some((x) => x.tipo === 'finConexion'));
  // El último estado de juego es "Game Ended": ya no lo pisa "Round 24".
  const estados = a.filter((x) => x.tipo === 'estadoJuego');
  assert.equal(estados.at(-1)?.tipo === 'estadoJuego' && estados.at(-1)?.mensaje, 'Game Ended');
  assert.ok(!estados.some((x) => x.tipo === 'estadoJuego' && x.mensaje.startsWith('Round ')));

  // La caché se vació: un segundo game_end sin datos nuevos es un empate 0-0 sin aviso.
  const otra = t.info({ key: 'round_phase', value: 'game_end' });
  assert.equal(otra.some((x) => x.tipo === 'finMapa'), false);
});

test('game_end: gana el equipo 1 y el empate no notifica', () => {
  const t = new TraductorObservador();
  t.info({ key: 'match_score', value: '{"team_0":5,"team_1":13}' });
  const fin = t.info({ key: 'round_phase', value: 'game_end' }).find((x) => x.tipo === 'finMapa');
  assert.ok(fin && fin.tipo === 'finMapa' && fin.datos.ganador === 1 && fin.datos.map === '' && fin.datos.matchId === '');

  const e = new TraductorObservador();
  e.info({ key: 'match_score', value: '{"team_0":12,"team_1":12}' });
  const empate = e.info({ key: 'round_phase', value: 'game_end' });
  assert.equal(empate.some((x) => x.tipo === 'finMapa'), false);
  assert.ok(empate.some((x) => x.tipo === 'finConexion'));
});

test('volver al menú vacía roster y marcador de rondas', () => {
  const t = new TraductorObservador();
  t.info({ key: 'scoreboard_0', value: marcadorGep('viejo', 0) });
  t.info({ key: 'match_score', value: '{"team_0":7,"team_1":2}' });
  t.info({ key: 'scene', value: 'MainMenu' });
  t.info({ key: 'match_score', value: '{"team_0":13,"team_1":1}' });
  const fin = t.info({ key: 'round_phase', value: 'game_end' }).find((x) => x.tipo === 'finMapa');
  assert.ok(fin && fin.tipo === 'finMapa');
  assert.deepEqual(fin.datos.roster, []);
});

test('match_end: fin de conexión y "Game Ended"', () => {
  const t = new TraductorObservador();
  const a = t.evento({ key: 'match_end', value: null });
  assert.ok(a.some((x) => x.tipo === 'finConexion'));
  assert.ok(a.some((x) => x.tipo === 'estadoJuego' && x.mensaje === 'Game Ended'));
});

test('al autenticar se reenvían mapa, modo y (si la partida sigue) match_start', () => {
  const t = new TraductorObservador();
  assert.deepEqual(t.alAutenticar(), []);
  t.info({ key: 'map', value: 'Bonsai' });
  t.info({ key: 'game_mode', value: '{"mode":"bomb","custom":true}' });
  t.info({ key: 'match_id', value: 'm-9' });
  assert.deepEqual(envios(t.alAutenticar()), [
    { type: 'map', data: 'Bonsai' },
    { type: 'game_mode', data: 'bomb' },
  ]);
  t.evento({ key: 'match_start', value: null });
  assert.deepEqual(envios(t.alAutenticar()).at(-1), { type: 'match_start', data: 'm-9' });
});

test('claves ignoradas y no tratadas', () => {
  const t = new TraductorObservador();
  assert.deepEqual(t.info({ key: 'region', value: 'eu' }), []);
  const otra = t.info({ key: 'algo_nuevo', value: 1 });
  assert.equal(otra.length, 1);
  assert.equal(otra[0].tipo, 'log');
});
