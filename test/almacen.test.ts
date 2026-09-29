/**
 * Almacenamiento local: formato en disco estable, CRUD de la base del
 * operador, secretos con caducidad y carpeta de datos.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Almacen } from '../src/principal/almacen.ts';
import { Coleccion, creaColecciones } from '../src/principal/coleccion.ts';
import { Recuerdos, VIGENCIA_MS } from '../src/principal/secreto.ts';
import { eligeDirectorioDatos } from '../src/principal/sistema/datos.ts';

const carpetas: string[] = [];
const temporal = () => {
  const c = mkdtempSync(join(tmpdir(), 'easyhud-cliente-'));
  carpetas.push(c);
  return c;
};
after(() => {
  for (const c of carpetas) rmSync(c, { recursive: true, force: true });
});

test('almacén: storage/<clave>.json, clave ausente = {}, escritura atómica', async () => {
  const dir = temporal();
  const a = new Almacen(dir);
  assert.deepEqual(a.lee('traySetting'), {});
  await a.escribe('traySetting', { traySetting: false });
  assert.equal(readFileSync(join(dir, 'storage', 'traySetting.json'), 'utf8'), '{"traySetting":false}');
  assert.deepEqual(a.lee('traySetting'), { traySetting: false });
  // Un fichero ilegible se lee como vacío.
  writeFileSync(join(dir, 'storage', 'windowState.json'), '{roto');
  assert.deepEqual(a.lee('windowState'), {});
});

test('almacén: lee datos de una instalación existente (mismo formato)', () => {
  const dir = temporal();
  mkdirSync(join(dir, 'storage'));
  const previos = { items: [{ id: 'a1', name: 'Equipo viejo', createdAt: 1, updatedAt: 1 }] };
  writeFileSync(join(dir, 'storage', 'db-teams.json'), JSON.stringify(previos));
  const c = creaColecciones(new Almacen(dir));
  assert.deepEqual(c.teams.list(), previos.items);
  assert.deepEqual(c.matches.list(), []);
});

test('CRUD: create/list/update/delete con la forma que espera el panel', async () => {
  const dir = temporal();
  const almacen = new Almacen(dir);
  let ahora = 1000;
  const c = new Coleccion(almacen, 'db-teams', () => ahora);

  const creado = await c.create({ name: 'Rojos', tricode: 'ROJ', id: 'pisado', createdAt: 5 });
  assert.equal(typeof creado.id, 'string');
  assert.notEqual(creado.id, 'pisado');
  assert.equal(creado.createdAt, 1000);
  assert.equal(creado.updatedAt, 1000);
  assert.equal(creado.name, 'Rojos');

  ahora = 2000;
  const segundo = await c.create({ name: 'Azules' });
  assert.deepEqual(c.list().map((x) => x.name), ['Rojos', 'Azules']);

  ahora = 3000;
  const cambiado = await c.update(creado.id, { tricode: 'RJS', id: 'otro', createdAt: 0 });
  assert.ok(cambiado);
  assert.equal(cambiado.id, creado.id);
  assert.equal(cambiado.createdAt, 1000);
  assert.equal(cambiado.updatedAt, 3000);
  assert.equal(cambiado.tricode, 'RJS');
  assert.equal(cambiado.name, 'Rojos');
  assert.equal(await c.update('no-existe', {}), null);

  assert.equal(await c.delete(segundo.id), true);
  assert.equal(await c.delete(segundo.id), false);

  // En disco, con la forma {items: [...]}.
  const disco = JSON.parse(readFileSync(join(dir, 'storage', 'db-teams.json'), 'utf8'));
  assert.deepEqual(disco, { items: [cambiado] });
});

test('CRUD: dos create sin esperar no pierden ninguno', async () => {
  const dir = temporal();
  const c = new Coleccion(new Almacen(dir), 'db-matches');
  await Promise.all([c.create({ n: 1 }), c.create({ n: 2 }), c.create({ n: 3 })]);
  const otra = new Coleccion(new Almacen(dir), 'db-matches');
  assert.deepEqual(otra.list().map((x) => x.n), [1, 2, 3]);
});

test('recuerdos: secreto 2 h (caducado se borra), matchId 2 h, puuid', async () => {
  const dir = temporal();
  const almacen = new Almacen(dir);
  let ahora = 1_000_000;
  const r = new Recuerdos(almacen, () => ahora);
  assert.equal(r.secretoVigente(), '');
  await r.recuerdaSecreto('ABCDEFGHIJKL');
  assert.deepEqual(almacen.lee('matchSecret'), { secret: 'ABCDEFGHIJKL', endTime: 1_000_000 + VIGENCIA_MS });
  assert.equal(r.secretoVigente(), 'ABCDEFGHIJKL');
  ahora += VIGENCIA_MS + 1;
  assert.equal(r.secretoVigente(), '');
  assert.equal(existsSync(join(dir, 'storage', 'matchSecret.json')), false);

  await r.guardaMatchId('m-1');
  assert.equal(r.matchIdVigente(), 'm-1');
  ahora += VIGENCIA_MS + 1;
  assert.equal(r.matchIdVigente(), '');

  await r.guardaPuuid('p-1');
  assert.deepEqual(almacen.lee('playerId'), { playerId: 'p-1' });
  assert.equal(r.puuid(), 'p-1');
});

test('carpeta de datos: jugador, observador y forzada', () => {
  const appData = 'C:\\Users\\X\\AppData\\Roaming';
  assert.equal(eligeDirectorioDatos({ appData, rol: 'jugador' }).carpeta, join(appData, 'EasyHUD-Jugador'));
  assert.equal(eligeDirectorioDatos({ appData, rol: 'jugador', forzada: 'D:\\x' }).carpeta, join(appData, 'EasyHUD-Jugador'));
  assert.equal(eligeDirectorioDatos({ appData, rol: 'observador' }).carpeta, join(appData, 'EasyHUD'));
  assert.equal(eligeDirectorioDatos({ appData, rol: 'observador', forzada: 'D:\\x' }).carpeta, 'D:\\x');
});
