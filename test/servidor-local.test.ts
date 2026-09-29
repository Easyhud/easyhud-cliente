/**
 * Servidor local del overlay: estáticos (200/403/404, tipos, no-store) y el
 * relevo sin credenciales.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { ServidorLocal } from '../src/principal/local/servidor-local.ts';

let raiz: string;
let local: ServidorLocal;

before(async () => {
  raiz = mkdtempSync(join(tmpdir(), 'easyhud-local-'));
  mkdirSync(join(raiz, 'operador'));
  writeFileSync(join(raiz, 'index.html'), '<!doctype html><title>director</title>');
  writeFileSync(join(raiz, 'operador', 'index.html'), '<title>operador</title>');
  writeFileSync(join(raiz, 'app.js'), 'export {}');
  local = new ServidorLocal({ raiz, puerto: 0, log: () => undefined });
});

after(async () => {
  await local.para();
  rmSync(raiz, { recursive: true, force: true });
});

/** GET con la ruta cruda (sin normalizar), como la mandaría cualquiera. */
function pide(ruta: string): Promise<{ estado: number; tipo: string; cache: string; cuerpo: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: local.puerto, path: ruta }, (res) => {
      let cuerpo = '';
      res.on('data', (t) => (cuerpo += t));
      res.on('end', () =>
        resolve({
          estado: res.statusCode ?? 0,
          tipo: String(res.headers['content-type']),
          cache: String(res.headers['cache-control']),
          cuerpo,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('estáticos', async () => {
  // Sin credenciales también sirve ficheros (el relevo es lo que las necesita).
  await local.arranca({ endpoint: 'http://127.0.0.1:1', token: 't', grupo: 'g' });
  const raizOk = await pide('/');
  assert.equal(raizOk.estado, 200);
  assert.equal(raizOk.tipo, 'text/html; charset=utf-8');
  assert.equal(raizOk.cache, 'no-store');
  assert.match(raizOk.cuerpo, /director/);
  assert.match((await pide('/operador/')).cuerpo, /operador/);
  assert.equal((await pide('/app.js')).tipo, 'text/javascript; charset=utf-8');
  assert.equal((await pide('/no-existe.png')).estado, 404);
  assert.equal((await pide('/no-existe.png')).cuerpo, 'not found');
  const fuera = await pide('/../../etc/passwd');
  assert.equal(fuera.estado, 403);
  assert.equal(fuera.cuerpo, 'forbidden');
  assert.equal((await pide('/%2e%2e/secreto')).estado, 403);
});

test('arrancar dos veces sólo cambia credenciales (mismo puerto)', async () => {
  const puerto = local.puerto;
  await local.arranca({ endpoint: 'http://127.0.0.1:1', token: 't2', grupo: 'g' });
  assert.equal(local.puerto, puerto);
});

test('relevo: el overlay recibe "el programa no llega al servidor" si arriba no hay nadie', async () => {
  const s = io(`http://localhost:${local.puerto}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  const denegado = await new Promise<{ reason: string }>((resolve) => s.once('logon_denied', (m: string) => resolve(JSON.parse(m))));
  assert.equal(denegado.reason, 'el programa no llega al servidor');
  s.close();
});

test('relevo: tras parar, el servidor ya no responde; sin credenciales se deniega', async () => {
  await local.para();
  await assert.rejects(pide('/'));
  // Uno nuevo sin credenciales: arrancarlo exige credenciales, así que se prueba el caso en frío.
  const frio = new ServidorLocal({ raiz, puerto: 0, log: () => undefined });
  await frio.arranca({ endpoint: 'http://127.0.0.1:1', token: 't', grupo: 'g' });
  (frio as unknown as { credenciales: null }).credenciales = null;
  const s = io(`http://localhost:${frio.puerto}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  const denegado = await new Promise<{ reason: string }>((resolve) => s.once('logon_denied', (m: string) => resolve(JSON.parse(m))));
  assert.equal(denegado.reason, 'sin sesión en el programa');
  s.close();
  await frio.para();
});
