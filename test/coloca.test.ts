/**
 * Colocar a cada jugador en su lado de la sala de Riot: validación de lo que manda el panel, el plan de
 * movimientos y el colocador contra un «cliente de Riot» de mentira.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Colocador, leeColocacion, planDeMovimientos, salaMovible } from '../src/principal/riot/coloca.ts';
import type { Sala, JugadorSala } from '../src/principal/riot/sala.ts';

const cerrar: Array<() => unknown> = [];
after(async () => {
  for (const c of cerrar.reverse()) await c();
});

const j = (puuid: string): JugadorSala => ({ puuid, nombre: puuid, tag: 'T', listo: true, moderador: false, hudBroadcast: false });
const sala = (p: Partial<Sala> = {}): Sala => ({
  equipoUno: [], equipoDos: [], observadores: [], coachesUno: [], coachesDos: [], coaches: [],
  estado: 'DEFAULT', codigo: 'ABC123', mapa: 'Ascent', modo: 'Estándar', servidor: '', cerrada: true, ...p,
});

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const YO = 'dddddddd-0000-0000-0000-000000000004';
const COACH = 'eeeeeeee-0000-0000-0000-000000000005';
const AUSENTE = 'ffffffff-0000-0000-0000-000000000006';

test('leeColocacion: sólo entradas válidas, sin repetidos y con tope', () => {
  const r = leeColocacion([
    { puuid: A, equipo: 'TeamOne' },
    { puuid: A, equipo: 'TeamTwo' }, // repetido: manda el primero
    { puuid: B, equipo: 'TeamTwo' },
    { puuid: 'no es un puuid!', equipo: 'TeamOne' },
    { puuid: C, equipo: 'Espectador' },
    null,
    'x',
  ]);
  assert.deepEqual(r, [{ puuid: A, equipo: 'TeamOne' }, { puuid: B, equipo: 'TeamTwo' }]);
  assert.deepEqual(leeColocacion('nada'), []);
  const muchos = Array.from({ length: 60 }, (_, i) => ({ puuid: `ffffffff-${String(i).padStart(4, '0')}-0000-0000-000000000000`, equipo: 'TeamOne' }));
  assert.equal(leeColocacion(muchos).length, 20);
});

test('planDeMovimientos: mueve sólo a quien está en la sala en el lado equivocado (o de espectador)', () => {
  const s = sala({ equipoUno: [j(A)], equipoDos: [j(B)], observadores: [j(C), j(YO)], coaches: [j(COACH)] });
  const plan = planDeMovimientos(
    s,
    [
      { puuid: A, equipo: 'TeamOne' }, // ya está bien
      { puuid: B, equipo: 'TeamOne' }, // equivocado
      { puuid: C, equipo: 'TeamTwo' }, // espectador → su lado
      { puuid: YO, equipo: 'TeamTwo' }, // el propio observador: nunca
      { puuid: AUSENTE, equipo: 'TeamOne' }, // no está en la sala: no se invita
      { puuid: COACH, equipo: 'TeamOne' }, // coach: no se toca
    ],
    YO,
  );
  assert.deepEqual(plan, [{ puuid: B, equipo: 'TeamOne' }, { puuid: C, equipo: 'TeamTwo' }]);
});

test('salaMovible: no con la partida en marcha ni buscando', () => {
  assert.equal(salaMovible(sala({ estado: 'DEFAULT' })), true);
  assert.equal(salaMovible(sala({ estado: 'CUSTOM_GAME_SETUP' })), true);
  assert.equal(salaMovible(sala({ estado: 'MATCHMAKING' })), false);
  assert.equal(salaMovible(sala({ estado: 'IN_MATCH' })), false);
});

/** Un cliente de Riot de mentira: lee la party y anota los movimientos que se le piden. */
async function riotFalso(respuestaMovimiento = 200) {
  const movimientos: Array<{ equipo: string; cuerpo: { playerToPutOnTeam?: string } }> = [];
  const s = createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on('data', (t: Buffer) => trozos.push(t));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === `/parties/v1/players/${YO}`) return res.end(JSON.stringify({ CurrentPartyID: 'party-1' }));
      if (req.method === 'GET' && req.url === '/parties/v1/parties/party-1') return res.end(JSON.stringify({ ID: 'party-1' }));
      const m = /customgamemembership\/(Team\w+)$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        movimientos.push({ equipo: m[1], cuerpo: JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}') });
        res.statusCode = respuestaMovimiento;
        return res.end('{}');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  cerrar.push(() => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }));
  const glz = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const riot = {
    contexto: async () => ({ puuid: YO, glz, pd: '', region: '', cabeceras: {} }),
    olvida: () => undefined,
  };
  return { riot, movimientos };
}

test('colocador: mueve al jugador al lado que le toca con la API local, y no repite antes de la espera', async () => {
  const { riot, movimientos } = await riotFalso();
  let t = 1_000;
  const logs: string[] = [];
  const col = new Colocador({ riot, puuidPropio: async () => YO, log: (x) => logs.push(x), esperaMs: 5_000, ahora: () => t });
  col.fija([{ puuid: A, equipo: 'TeamTwo' }]);
  const s = sala({ equipoUno: [j(A)] });
  assert.equal(await col.aplica(s), 1);
  assert.deepEqual(movimientos, [{ equipo: 'TeamTwo', cuerpo: { playerToPutOnTeam: A } }]);
  assert.ok(logs.some((l) => /pasado a Attackers/.test(l)));

  // La sala aún lo ve en el lado viejo (Riot tarda): no se insiste hasta pasada la espera.
  t += 1_000;
  assert.equal(await col.aplica(s), 0);
  t += 5_000;
  assert.equal(await col.aplica(s), 1);
  assert.equal(movimientos.length, 2);
});

test('colocador: Riot lo rechaza → se detiene al llegar al tope y lo dice en el log', async () => {
  const { riot, movimientos } = await riotFalso(403);
  let t = 1_000;
  const logs: string[] = [];
  const col = new Colocador({ riot, puuidPropio: async () => YO, log: (x) => logs.push(x), esperaMs: 100, maxIntentos: 3, ahora: () => t });
  col.fija([{ puuid: B, equipo: 'TeamOne' }]);
  const s = sala({ equipoDos: [j(B)] });
  for (let i = 0; i < 8; i++) {
    t += 500;
    await col.aplica(s);
  }
  assert.equal(movimientos.length, 3, 'se rinde tras el tope de intentos');
  assert.ok(logs.some((l) => /anfitrión/.test(l)), 'explica que quizá no es el anfitrión');
});

test('colocador: sin nada que colocar, o con la partida en marcha, no toca nada', async () => {
  const { riot, movimientos } = await riotFalso();
  const col = new Colocador({ riot, puuidPropio: async () => YO, log: () => undefined });
  assert.equal(await col.aplica(sala({ equipoUno: [j(A)] })), 0, 'sin lista deseada');
  col.fija([{ puuid: A, equipo: 'TeamTwo' }]);
  assert.equal(await col.aplica(sala({ equipoUno: [j(A)], estado: 'IN_MATCH' })), 0, 'partida en marcha');
  assert.equal(await col.aplica(null), 0, 'sin sala');
  assert.equal(movimientos.length, 0);
});

test('colocador: al cambiar lo deseado (Switch teams) reevalúa en el acto con la última sala', async () => {
  const { riot, movimientos } = await riotFalso();
  const col = new Colocador({ riot, puuidPropio: async () => YO, log: () => undefined, esperaMs: 0 });
  col.fija([{ puuid: A, equipo: 'TeamOne' }]);
  await col.aplica(sala({ equipoUno: [j(A)] })); // ya está bien: nada
  assert.equal(movimientos.length, 0);
  col.fija([{ puuid: A, equipo: 'TeamTwo' }]); // «Switch teams»: ahora le toca el otro lado
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(movimientos.length, 1);
  assert.equal(movimientos[0].equipo, 'TeamTwo');
});
