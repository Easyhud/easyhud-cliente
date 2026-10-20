/**
 * El sondeo de `getInfo`: la red de seguridad de los avisos de GEP que Overwolf no manda.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplanaInfo, SondeoInfo, type DatoInfo } from '../src/principal/gep/info-sondeo.ts';

test('aplanaInfo: acepta las tres formas en que puede venir (directa, «info» y «res»)', () => {
  const dentro = { me: { health: '100', abilities: '{"C":1}' }, match_info: { round_phase: 'combat' }, game_info: { scene: 'Ascent' } };
  const claves = (x: unknown) => aplanaInfo(x).map((d) => d.key).sort();
  const esperado = ['abilities', 'health', 'round_phase', 'scene'];
  assert.deepEqual(claves(dentro), esperado);
  assert.deepEqual(claves({ info: dentro }), esperado);
  assert.deepEqual(claves({ res: dentro }), esperado);
  assert.deepEqual(claves({ status: 'success', res: dentro }), esperado);
  assert.deepEqual(aplanaInfo(null), []);
  assert.deepEqual(aplanaInfo('nada'), []);
});

test('sondeo: reenvía sólo lo que CAMBIÓ, sólo las claves del jugador, y cuenta qué tiene GEP', async () => {
  let estado: unknown = { me: { health: '100', abilities: '{"C":1}', player_name: 'Yo#EUW' }, match_info: { scoreboard_3: '{"name":"Yo"}', roster_1: 'x' } };
  const entregados: DatoInfo[] = [];
  let claves: string[] = [];
  const s = new SondeoInfo({ lee: async () => estado, entrega: (d) => entregados.push(d), alLeer: (c) => (claves = c) });
  const llaves = () => entregados.map((d) => d.key).sort();
  const pares = () => entregados.map((d) => [d.key, d.value]);

  await s.vuelta();
  assert.deepEqual(llaves(), ['abilities', 'health', 'scoreboard_3'], 'player_name y roster no se reenvían');
  assert.deepEqual(claves.sort(), ['abilities', 'health', 'player_name', 'roster_n', 'scoreboard_n']);

  entregados.length = 0;
  await s.vuelta();
  assert.deepEqual(entregados, [], 'sin cambios no se repite nada');

  estado = { me: { health: '64', abilities: '{"C":1}' }, match_info: {} };
  await s.vuelta();
  assert.deepEqual(pares(), [['health', '64']], 'sólo la vida cambió');

  s.reinicia(); // partida nueva: todo vuelve a salir
  entregados.length = 0;
  await s.vuelta();
  assert.deepEqual(llaves(), ['abilities', 'health']);
});

test('sondeo: ignora valores vacíos y no se rompe si GEP no responde (sin juego)', async () => {
  const entregados: DatoInfo[] = [];
  const logs: string[] = [];
  let falla = true;
  const s = new SondeoInfo({
    lee: async () => {
      if (falla) throw new Error('sin juego');
      return { me: { health: '', abilities: null } };
    },
    entrega: (d) => entregados.push(d),
    log: (t) => logs.push(t),
  });
  await s.vuelta();
  await s.vuelta();
  assert.equal(logs.length, 1, 'el fallo se anota una vez, no en cada vuelta');
  falla = false;
  await s.vuelta();
  assert.deepEqual(entregados, [], 'vacío y nulo no se reenvían');
});

test('sondeo: no se pisa a sí mismo si una lectura tarda más que el periodo', async () => {
  let llamadas = 0;
  let suelta: () => void = () => undefined;
  const s = new SondeoInfo({
    lee: () => {
      llamadas += 1;
      // Sólo la primera lectura tarda; las siguientes responden al instante.
      if (llamadas > 1) return Promise.resolve({ me: { health: '50' } });
      return new Promise((r) => (suelta = () => r({ me: { health: '50' } })));
    },
    entrega: () => undefined,
  });
  const primera = s.vuelta();
  await s.vuelta(); // mientras la primera sigue esperando: no lanza otra
  assert.equal(llamadas, 1);
  suelta();
  await primera;
  await s.vuelta();
  assert.equal(llamadas, 2);
});
