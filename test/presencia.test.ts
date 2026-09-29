/**
 * Presencia temprana del jugador: el puuid sale del cliente de Riot local
 * (lockfile + `/entitlements/v1/token`) sin esperar a GEP, y la presencia late
 * con él en cuanto se conoce.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as ServidorHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { Presencia } from '../src/principal/enlace/presencia.ts';
import { FuentePuuid, leePuuidLocal } from '../src/principal/riot/puuid-local.ts';

const carpetas: string[] = [];
const cerrar: Array<() => unknown> = [];
after(async () => {
  for (const c of cerrar.reverse()) await c();
  for (const c of carpetas) rmSync(c, { recursive: true, force: true });
});

function escucha(s: ServidorHttp): Promise<number> {
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port)));
}

/** Un "cliente de Riot" local de mentira y su LOCALAPPDATA con el lockfile. */
async function riotFalso(subject: string): Promise<{ appData: string; cabeceras: () => string | undefined }> {
  let auth: string | undefined;
  const s = createServer((req, res) => {
    auth = req.headers.authorization;
    if (req.url !== '/entitlements/v1/token') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ subject, accessToken: 'a', token: 't' }));
  });
  const puerto = await escucha(s);
  cerrar.push(() => new Promise((r) => s.close(r)));
  const appData = mkdtempSync(join(tmpdir(), 'easyhud-riot-'));
  carpetas.push(appData);
  const config = join(appData, 'Riot Games', 'Riot Client', 'Config');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'lockfile'), `Riot Client:1234:${puerto}:clave-secreta:http`);
  return { appData, cabeceras: () => auth };
}

test('leePuuidLocal: saca el puuid de la sesión del cliente de Riot con la clave del lockfile', async () => {
  const riot = await riotFalso('puuid-de-riot');
  assert.equal(await leePuuidLocal(riot.appData), 'puuid-de-riot');
  assert.equal(riot.cabeceras(), `Basic ${Buffer.from('riot:clave-secreta').toString('base64')}`);
});

test('leePuuidLocal: sin cliente de Riot (sin lockfile, o puerto muerto) devuelve vacío', async () => {
  const vacia = mkdtempSync(join(tmpdir(), 'easyhud-riot-'));
  carpetas.push(vacia);
  assert.equal(await leePuuidLocal(vacia), '');
  assert.equal(await leePuuidLocal(''), '');
  const config = join(vacia, 'Riot Games', 'Riot Client', 'Config');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'lockfile'), 'Riot Client:1:1:x:http');
  assert.equal(await leePuuidLocal(vacia), '');
});

test('FuentePuuid: Riot manda sobre GEP/guardado, avisa al cambiar y conserva el último si Riot se cierra', async () => {
  let deRiot = '';
  let deGep = '';
  const cambios: string[] = [];
  const f = new FuentePuuid({
    lee: async () => deRiot,
    respaldo: () => deGep,
    alCambiar: (p) => cambios.push(p),
    periodoMs: 60_000,
  });
  f.arranca();
  await f.sondea();
  assert.equal(f.actual(), '');
  assert.deepEqual(cambios, []);

  deGep = 'puuid-gep';
  f.avisaSiCambio();
  assert.deepEqual(cambios, ['puuid-gep']);

  deRiot = 'puuid-riot';
  await f.sondea();
  assert.equal(f.actual(), 'puuid-riot');
  assert.deepEqual(cambios, ['puuid-gep', 'puuid-riot']);

  deRiot = ''; // el jugador cerró el cliente de Riot
  await f.sondea();
  assert.equal(f.actual(), 'puuid-riot');
  assert.equal(cambios.length, 2);
  f.para();
});

test('la presencia late con el puuid de Riot en el menú, sin ningún dato de GEP', async () => {
  const riot = await riotFalso('puuid-menu');
  const http = createServer();
  const io = new Server(http);
  const puerto = await escucha(http);
  cerrar.push(() => new Promise((r) => io.close(() => r(undefined))));
  const latidos: string[] = [];
  const primero = new Promise<void>((resolve) => {
    io.on('connection', (s) => s.on('cliente_presente', (m: string) => {
      latidos.push(JSON.parse(m).puuid);
      resolve();
    }));
  });

  let presencia: Presencia | null = null;
  const fuente = new FuentePuuid({
    lee: () => leePuuidLocal(riot.appData),
    respaldo: () => '', // GEP todavía no dijo nada
    alCambiar: () => presencia?.late(),
  });
  presencia = new Presencia({
    url: `http://127.0.0.1:${puerto}`,
    puuid: () => fuente.actual(),
    alLlamar: () => undefined,
    log: () => undefined,
    periodoMs: 60_000,
  });
  presencia.arranca();
  fuente.arranca();
  cerrar.push(() => {
    fuente.para();
    presencia?.para();
  });

  await Promise.race([primero, new Promise((_, no) => setTimeout(() => no(new Error('sin latido')), 5000).unref())]);
  assert.equal(latidos[0], 'puuid-menu');
});
