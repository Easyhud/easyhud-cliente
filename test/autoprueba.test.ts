/**
 * Autoprueba de red y reglas del Firewall: dónde se corta la conexión y qué se le pide a Windows.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as ServidorHttp } from 'node:http';
import { Server } from 'socket.io';
import { consejo, ejecutaAutoprueba } from '../src/principal/diagnostico/autoprueba.ts';
import { argumentosElevados, guionReglas } from '../src/principal/sistema/firewall.ts';

const cerrar: Array<() => unknown> = [];
after(async () => {
  for (const c of cerrar.reverse()) await c();
});

const escucha = (s: ServidorHttp, puerto = 0): Promise<number> =>
  new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(puerto, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
  });

/** Dos puertos CONSECUTIVOS libres: el de datos y el de «extras» (datos + 1), como en el servidor real. */
async function parDePuertos(): Promise<{ datos: ServidorHttp; extras: ServidorHttp; puerto: number }> {
  for (let intento = 0; intento < 40; intento++) {
    const datos = createServer();
    const puerto = await escucha(datos);
    const extras = createServer((_q, r) => r.end('{"status":"UP"}'));
    try {
      await escucha(extras, puerto + 1);
      cerrar.push(() => new Promise((r) => { datos.closeAllConnections?.(); datos.close(r); }));
      cerrar.push(() => new Promise((r) => extras.close(r)));
      return { datos, extras, puerto };
    } catch {
      await new Promise((r) => datos.close(r));
    }
  }
  throw new Error('no hay dos puertos consecutivos libres');
}

test('autoprueba: todo en orden → los cuatro pasos bien', async () => {
  const { datos, puerto } = await parDePuertos();
  const io = new Server(datos);
  cerrar.push(() => new Promise((r) => io.close(() => r(undefined))));
  const r = await ejecutaAutoprueba({ url: `http://127.0.0.1:${puerto}`, tiempoMs: 3000 });
  assert.deepEqual(r.pruebas.map((p) => [p.id, p.ok]), [['dns', true], ['tcp', true], ['http', true], ['websocket', true]]);
  assert.equal(r.ok, true);
  assert.equal(r.causa, null);
});

test('autoprueba: el puerto de datos responde pero WebSocket no (proxy/antivirus) → causa «proxy»', async () => {
  const { puerto } = await parDePuertos(); // un servidor HTTP plano, sin socket.io
  const r = await ejecutaAutoprueba({ url: `http://127.0.0.1:${puerto}`, tiempoMs: 1500 });
  const ws = r.pruebas.find((p) => p.id === 'websocket');
  assert.equal(r.pruebas.find((p) => p.id === 'tcp')?.ok, true);
  assert.equal(r.pruebas.find((p) => p.id === 'http')?.ok, true);
  assert.equal(ws?.ok, false);
  assert.equal(r.causa?.arreglo, 'proxy');
  assert.match(consejo('proxy'), /proxy/i);
});

test('autoprueba: el puerto rechaza la conexión (servidor caído) → causa «servidor»', async () => {
  const r = await ejecutaAutoprueba({ url: 'http://127.0.0.1:1', tiempoMs: 1500 });
  assert.equal(r.pruebas.find((p) => p.id === 'dns')?.ok, true);
  const tcp = r.pruebas.find((p) => p.id === 'tcp');
  assert.equal(tcp?.ok, false);
  assert.match(tcp?.detalle ?? '', /refused/);
  assert.equal(r.causa?.arreglo, 'servidor');
  assert.equal(r.ok, false);
  assert.match(r.resumen, /FAILS/);
});

test('autoprueba: el nombre no se resuelve (sin internet) → causa «internet» y el resto sin probar', async () => {
  const r = await ejecutaAutoprueba({ url: 'http://no-existe.invalid:5100', tiempoMs: 3000 });
  assert.equal(r.pruebas[0].ok, false);
  assert.deepEqual(r.pruebas.slice(1).map((p) => p.ok), [null, null, null]);
  assert.equal(r.causa?.arreglo, 'internet');
});

test('autoprueba: una dirección de servidor inválida se explica en vez de romper', async () => {
  const r = await ejecutaAutoprueba({ url: 'http://:::::' });
  assert.equal(r.ok, false);
  assert.match(r.pruebas[0].detalle, /not valid/);
});

test('firewall: el guion borra las reglas viejas y crea entrada y salida para ESTE ejecutable', () => {
  const g = guionReglas("C:\Users\Ana O'Neil\Descargas\EasyHUD-Player.exe");
  assert.match(g, /delete rule name='Easy HUD'/);
  assert.match(g, /dir=out action=allow/);
  assert.match(g, /dir=in action=allow/);
  assert.ok(g.includes("Ana O''Neil"), 'la comilla simple del nombre se escapa');
  assert.equal(g.match(/program=/g)?.length, 2);
});

test('firewall: se lanza elevado (RunAs) y el guion va codificado, sin comillas que se rompan', () => {
  const exe = 'C:\Easy HUD\EasyHUD-Player.exe';
  const args = argumentosElevados(exe);
  const orden = args.at(-1) ?? '';
  assert.match(orden, /Start-Process -FilePath powershell\.exe/);
  assert.match(orden, /-Verb RunAs/);
  const codificado = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(orden)?.[1] ?? '';
  assert.ok(codificado.length > 20);
  assert.equal(Buffer.from(codificado, 'base64').toString('utf16le'), guionReglas(exe), 'lo codificado es exactamente el guion');
});
