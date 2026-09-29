/**
 * Traductor del jugador: aux_* y el bucle de 300 ms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Accion } from '../src/principal/gep/acciones.ts';
import { TraductorJugador } from '../src/principal/gep/jugador.ts';

const envios = (acciones: Accion[]) =>
  acciones.filter((a): a is Extract<Accion, { tipo: 'envia' }> => a.tipo === 'envia').map((a) => ({ type: a.type, data: a.data }));

const marcador = (extra: Record<string, unknown>) =>
  JSON.stringify({ name: 'Yo #EUW', player_id: 'mio', team: 0, character: 'Clay', alive: true, armor: 25, money: 1000, kills: 1, deaths: 0, assists: 0, ...extra });

test('marcador local: aux_scoreboard, y su puuid se aprende y se persiste', () => {
  const t = new TraductorJugador();
  const a = t.procesa({ key: 'scoreboard_0', value: marcador({ is_local: true }) });
  assert.deepEqual(a[0], { tipo: 'persistePuuid', puuid: 'mio' });
  assert.equal(envios(a)[0].type, 'aux_scoreboard');
  assert.equal(t.puuid, 'mio');
});

test('compañeros: se acumulan y el bucle los manda como texto JSON; luego se vacía', () => {
  const t = new TraductorJugador('mio');
  assert.deepEqual(t.procesa({ key: 'scoreboard_1', value: marcador({ player_id: 'amigo', teammate: true }) }), []);
  assert.deepEqual(t.procesa({ key: 'scoreboard_2', value: marcador({ player_id: 'rival', teammate: false }) }), []);
  const [envio] = envios(t.tick());
  assert.equal(envio.type, 'aux_scoreboard_team');
  assert.equal(typeof envio.data, 'string');
  const lista = JSON.parse(envio.data as string);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].playerId, 'amigo');
  assert.equal('name' in lista[0], false);
  assert.deepEqual(t.tick(), []);
});

test('vida: se manda sólo cuando cambia; reiniciar la vuelve a mandar', () => {
  const t = new TraductorJugador();
  t.procesa({ key: 'health', value: '100' });
  assert.deepEqual(envios(t.tick()), [{ type: 'aux_health', data: 100 }]);
  assert.deepEqual(t.tick(), []);
  t.procesa({ key: 'health', value: 70 });
  assert.deepEqual(envios(t.tick()), [{ type: 'aux_health', data: 70 }]);
  t.reinicia();
  assert.deepEqual(envios(t.tick()), [{ type: 'aux_health', data: 70 }]);
});

test('habilidades y round_report con reintento; nada si soy espectador', () => {
  const t = new TraductorJugador();
  const h = t.procesa({ key: 'abilities', value: '{"C":1,"Q":2,"E":0,"X":6}' });
  assert.deepEqual(h, [{ tipo: 'envia', type: 'aux_abilities', data: { grenade: 1, ability_1: 2, ability_2: 0, ultimate: 6 }, reintentoMs: 1500 }]);
  const r = t.procesa({ key: 'round_report', value: '{"damage":"140","damage_received":"30","headshot":"1"}' });
  assert.equal(r[0].tipo === 'envia' && r[0].type, 'aux_round_report');
  assert.deepEqual(r[0].tipo === 'envia' && r[0].data, {
    damage: 140,
    damageReceived: 30,
    hits: 0,
    headshots: 1,
    bodyshots: 0,
    legshots: 0,
    finalHeadshot: false,
    abilityDamage: 0,
  });

  t.procesa({ key: 'team', value: 'observer' });
  assert.equal(t.soyEspectador, true);
  assert.deepEqual(t.procesa({ key: 'abilities', value: '{"C":1}' }), []);
  // Como espectador reenvía cualquier marcador.
  assert.equal(envios(t.procesa({ key: 'scoreboard_4', value: marcador({ player_id: 'otro' }) }))[0].type, 'aux_scoreboard');
  t.procesa({ key: 'scene', value: 'MainMenu' });
  assert.equal(t.soyEspectador, false);
});

test('agentes: Astra (Rift) y Cypher (Gumshoe)', () => {
  const t = new TraductorJugador();
  assert.deepEqual(envios(t.procesa({ key: 'agent', value: 'Rift_Targeting' })), [{ type: 'aux_astra_targeting', data: true }]);
  assert.deepEqual(envios(t.procesa({ key: 'agent', value: 'Rift' })), [{ type: 'aux_astra_targeting', data: false }]);
  assert.deepEqual(envios(t.procesa({ key: 'agent', value: 'Gumshoe_PossessableCamera' })), [{ type: 'aux_cypher_cam', data: true }]);
  assert.deepEqual(t.procesa({ key: 'agent', value: 'Clay' }), []);
});

test('conexión: sólo en custom de bomba/swift; match_start con 1 s de margen', () => {
  const t = new TraductorJugador();
  assert.deepEqual(t.procesa({ key: 'round_phase', value: 'end' }), []);
  t.procesa({ key: 'game_mode', value: '{"mode":"bomb","custom":true}' });
  assert.deepEqual(t.procesa({ key: 'round_phase', value: 'end' }), [{ tipo: 'conecta' }]);
  assert.deepEqual(t.procesa({ key: 'match_start', value: null }), [{ tipo: 'conecta', retardoMs: 1000 }]);
  t.procesa({ key: 'game_mode', value: '{"mode":"deathmatch","custom":true}' });
  assert.deepEqual(t.procesa({ key: 'match_start', value: null }), []);
});

test('game_end: persiste el puuid y cierra la conexión', () => {
  const t = new TraductorJugador();
  assert.deepEqual(t.procesa({ key: 'player_id', value: 'p-9' }), [{ tipo: 'persistePuuid', puuid: 'p-9' }]);
  t.procesa({ key: 'observing', value: 'x' });
  const a = t.procesa({ key: 'round_phase', value: 'game_end' });
  assert.deepEqual(a[0], { tipo: 'persistePuuid', puuid: 'p-9' });
  assert.ok(a.some((x) => x.tipo === 'finConexion'));
  assert.equal(t.soyEspectador, false);
});

test('nombre y matchId se recuerdan; el roster se ignora', () => {
  const t = new TraductorJugador();
  t.procesa({ key: 'player_name', value: 'Yo' });
  t.procesa({ key: 'match_id', value: 'm-2' });
  assert.equal(t.nombre, 'Yo');
  assert.equal(t.matchId, 'm-2');
  assert.deepEqual(t.procesa({ key: 'roster_0', value: '{"name":"x"}' }), []);
});
