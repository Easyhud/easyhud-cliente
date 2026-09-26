/**
 * Integración contra el servidor de partidas v2 DE VERDAD (`../servidor-v2`),
 * arrancado en puertos libres, con el enlace, la presencia y el servidor local
 * del cliente tal cual se usan en el programa (sin Electron ni GEP: los datos
 * de GEP se simulan pasando por el traductor real).
 *
 *   · logon del observador con un token firmado por el módulo del servidor;
 *   · los datos llegan a un overlay conectado por el relevo local (5310);
 *   · tras una caída del transporte, el enlace repite el logon solo
 *     (`reconnected`) y los datos siguen llegando;
 *   · jugador: presencia → "Call players" → `te_llaman` → logon por grupo;
 *   · jugador por matchId;
 *   · rechazos traducidos y servidor inalcanzable.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { arranca, type Servidor } from '../../servidor-v2/src/servidor.ts';
import { firmaToken } from '../../servidor-v2/src/token.ts';
import { silencia as silenciaServidor } from '../../servidor-v2/src/log.ts';
import type { Config } from '../../servidor-v2/src/config.ts';
import type { ClaseEstado } from '../src/principal/gep/acciones.ts';
import { EnlaceIngesta, type Avisos, type InfoAutenticado } from '../src/principal/enlace/conexion.ts';
import { Presencia } from '../src/principal/enlace/presencia.ts';
import { TraductorObservador } from '../src/principal/gep/observador.ts';
import { ServidorLocal } from '../src/principal/local/servidor-local.ts';
import { silencia } from '../src/principal/registro.ts';

const SECRETO = 'k'.repeat(48);
const VERSION = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

let servidor: Servidor;
let carpeta: string;
const cerrar: Array<() => unknown> = [];

before(async () => {
  silenciaServidor(true);
  silencia(true);
  carpeta = mkdtempSync(join(tmpdir(), 'easyhud-cliente-int-'));
  const config: Config = {
    inseguro: true,
    secretoToken: SECRETO,
    sinAutenticacion: false,
    exigirTokenOverlay: true,
    grabar: false,
    carpetaGrabaciones: carpeta,
    extraProrroga: 1,
    minutosInactividad: 30,
    puertos: { ingesta: 0, salida: 0, extras: 0 },
  };
  servidor = await arranca(config);
});

after(async () => {
  for (const c of cerrar.reverse()) await c();
  await servidor.cierra();
  rmSync(carpeta, { recursive: true, force: true });
});

const urlIngesta = () => `http://localhost:${servidor.puertos.ingesta}`;
const urlSalida = () => `http://localhost:${servidor.puertos.salida}`;

/** Avisos que se apuntan, y promesas para esperar al siguiente acuse. */
class Testigo implements Avisos {
  estados: string[] = [];
  dialogos: string[] = [];
  autenticaciones: InfoAutenticado[] = [];
  desconexiones = 0;
  private esperando: Array<(i: InfoAutenticado) => void> = [];
  estado(m: string, _c: ClaseEstado) {
    this.estados.push(m);
  }
  dialogo(t: string, m: string) {
    this.dialogos.push(`${t}: ${m}`);
  }
  autenticado(i: InfoAutenticado) {
    this.autenticaciones.push(i);
    for (const r of this.esperando.splice(0)) r(i);
  }
  desconectado() {
    this.desconexiones += 1;
  }
  log() {}
  siguienteAcuse(ms = 5000): Promise<InfoAutenticado> {
    return new Promise((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error('no llegó el acuse')), ms);
      this.esperando.push((i) => {
        clearTimeout(reloj);
        resolve(i);
      });
    });
  }
  esperaEstado(m: string, ms = 5000): Promise<void> {
    const inicio = Date.now();
    return new Promise((resolve, reject) => {
      const mira = () => {
        if (this.estados.includes(m)) return resolve();
        if (Date.now() - inicio > ms) return reject(new Error(`no llegó el estado ${m}: ${this.estados.join(', ')}`));
        setTimeout(mira, 20);
      };
      mira();
    });
  }
}

function espera<T = any>(s: Socket, evento: string, cumple: (d: T) => boolean = () => true, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const reloj = setTimeout(() => {
      s.off(evento, oyente);
      reject(new Error(`no llegó ${evento} a tiempo`));
    }, ms);
    const oyente = (msg: unknown) => {
      const d = typeof msg === 'string' ? JSON.parse(msg) : msg;
      if (!cumple(d)) return;
      clearTimeout(reloj);
      s.off(evento, oyente);
      resolve(d);
    };
    s.on(evento, oyente);
  });
}

function enlace(testigo: Testigo, secreto = () => '') {
  const e = new EnlaceIngesta({
    version: VERSION,
    avisos: testigo,
    secreto,
    opcionesSocket: { reconnectionDelay: 50, reconnectionDelayMax: 100 },
  });
  cerrar.push(() => e.cierra());
  return e;
}

/** Un observador conectado y autenticado en `grupo`. */
async function observador(grupo: string) {
  const testigo = new Testigo();
  let secreto = '';
  const e = enlace(testigo, () => secreto);
  const token = firmaToken(grupo, 1, 'Liga de Pruebas', SECRETO);
  const acuse = testigo.siguienteAcuse();
  e.abre(urlIngesta(), { rol: 'observador', token, grupo: grupo.toLowerCase() });
  const info = await acuse;
  if (info.secreto) secreto = info.secreto;
  return { e, testigo, token, info, secreto: () => secreto };
}

test('la versión del cliente está en el rango que acepta el servidor', async () => {
  const { clienteCompatible } = await import('../../servidor-v2/src/version.ts');
  assert.equal(clienteCompatible(VERSION), true, `versión ${VERSION} fuera del rango del servidor`);
});

test('observador: logon, datos al overlay por el relevo local y reconexión con re-logon', async () => {
  const grupo = 'INTEG1';
  const { e, testigo, token, info } = await observador(grupo);
  assert.equal(info.rol, 'observador');
  assert.equal(typeof info.secreto, 'string');
  assert.equal(info.secreto?.length, 12);
  assert.equal(e.autenticado, true);
  assert.ok(testigo.estados.includes('Connected'));

  // Relevo local, con el grupo en minúsculas como podría darlo la cuenta.
  const local = new ServidorLocal({ raiz: join(import.meta.dirname, '..', 'recursos'), puerto: 0, log: () => undefined });
  cerrar.push(() => local.para());
  await local.arranca({ endpoint: urlSalida(), token, grupo: grupo.toLowerCase() });
  const overlay = io(`http://localhost:${local.puerto}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  cerrar.push(() => overlay.close());
  const exito = espera(overlay, 'logon_success');
  // Lo que mande el overlay en su logon se ignora: la credencial la pone el programa.
  overlay.emit('logon', JSON.stringify({ groupCode: 'OTRO', token: 'falso' }));
  assert.equal((await exito).groupCode, grupo);

  // Datos de GEP → traductor real → enlace → servidor → relevo → overlay.
  const t = new TraductorObservador();
  const manda = (acciones: ReturnType<TraductorObservador['info']>) => {
    for (const a of acciones) if (a.tipo === 'envia') e.enviaObservador(a.type, a.data);
  };
  const ronda3 = espera(overlay, 'match_data', (m) => m.roundNumber === 3 && m.roundPhase === 'shopping');
  manda(t.info({ key: 'round_number', value: '3' }));
  manda(t.info({ key: 'round_phase', value: 'shopping' }));
  await ronda3;

  // Caída del transporte: socket.io reconecta solo y el enlace repite el logon.
  const reacuse = testigo.siguienteAcuse();
  (e as unknown as { socket: Socket }).socket.io.engine.close();
  const segundo = await reacuse;
  assert.equal(segundo.reason, 'reconnected');
  assert.equal(segundo.secreto, undefined);
  assert.ok(testigo.estados.includes('Reconnecting'));
  assert.equal(testigo.desconexiones >= 1, true);

  const ronda4 = espera(overlay, 'match_data', (m) => m.roundNumber === 4 && m.roundPhase === 'combat');
  manda(t.info({ key: 'round_number', value: 4 }));
  manda(t.info({ key: 'round_phase', value: 'combat' }));
  await ronda4;
});

test('observador: un segundo observador en el mismo grupo recibe el texto amable', async () => {
  await observador('INTEG2');
  const testigo = new Testigo();
  const e = enlace(testigo);
  e.abre(urlIngesta(), { rol: 'observador', token: firmaToken('INTEG2', 1, 'Otro', SECRETO), grupo: 'INTEG2' });
  await testigo.esperaEstado('Connection Failed');
  assert.match(testigo.dialogos.join('\n'), /already a live broadcast/);
  assert.equal(e.autenticado, false);
  assert.equal(e.abierto, false);
});

test('observador: token caducado → "expired"', async () => {
  const testigo = new Testigo();
  const e = enlace(testigo);
  e.abre(urlIngesta(), { rol: 'observador', token: firmaToken('INTEG3', 1, 'x', SECRETO, Date.now() - 3 * 86400_000), grupo: 'INTEG3' });
  await testigo.esperaEstado('Connection Failed');
  assert.match(testigo.dialogos.join('\n'), /permit has expired/);
});

test('jugador: presencia → Call players → te_llaman → logon por grupo y aux_data', async () => {
  const grupo = 'INTEG4';
  const obs = await observador(grupo);

  const testigo = new Testigo();
  const jugador = enlace(testigo);
  const acuseJugador = testigo.siguienteAcuse(10_000);
  const llamado = new Promise<string>((resolve) => {
    const p = new Presencia({
      url: urlIngesta(),
      puuid: () => 'puuid-jugador',
      alLlamar: (g) => {
        jugador.abre(urlIngesta(), { rol: 'jugador', nombre: 'Jugador Uno', puuid: 'puuid-jugador', grupo: g });
        resolve(g);
      },
      log: () => undefined,
      periodoMs: 50,
    });
    p.arranca();
    cerrar.push(() => p.para());
  });

  // Espera a que el servidor haya visto el latido y llama.
  let r: Awaited<ReturnType<EnlaceIngesta['llamaJugadores']>> = { ok: false, error: '' };
  for (let i = 0; i < 40; i++) {
    r = await obs.e.llamaJugadores(['puuid-jugador', 'nadie']);
    if (r.ok && Array.isArray(r.avisados) && r.avisados.length > 0) break;
    await new Promise((s) => setTimeout(s, 50));
  }
  assert.deepEqual(r, { ok: true, avisados: ['puuid-jugador'] });
  assert.equal(await llamado, grupo);

  const info = await acuseJugador;
  assert.equal(info.rol, 'jugador');
  assert.equal(info.porGrupo, true);
  assert.equal(jugador.enviaJugador('aux_health', 87), true);

  // Sin conexión de observador, "Call players" responde el texto de la especificación.
  const suelto = enlace(new Testigo());
  assert.deepEqual(await suelto.llamaJugadores(['x']), { ok: false, error: 'No conectado como observador.' });
});

test('jugador por matchId: entra cuando el observador ya mandó match_start', async () => {
  const grupo = 'INTEG5';
  const obs = await observador(grupo);
  obs.e.enviaObservador('match_start', 'match-integracion-5');
  await new Promise((s) => setTimeout(s, 100));

  const testigo = new Testigo();
  const j = enlace(testigo);
  const acuse = testigo.siguienteAcuse();
  j.abre(urlIngesta(), { rol: 'jugador', nombre: 'Yo', puuid: 'p5', matchId: 'match-integracion-5' });
  const info = await acuse;
  assert.equal(info.porGrupo, false);

  const noExiste = new Testigo();
  const k = enlace(noExiste);
  k.abre(urlIngesta(), { rol: 'jugador', nombre: 'Yo', puuid: 'p6', matchId: 'no-existe' });
  await noExiste.esperaEstado('Connection Failed');
  assert.match(noExiste.dialogos.join('\n'), /no longer live/);
});

test('servidor inalcanzable: "Server Unreachable" y un solo diálogo', async () => {
  const testigo = new Testigo();
  const e = enlace(testigo);
  e.abre('http://127.0.0.1:1', { rol: 'observador', token: 'x.y', grupo: 'NADIE' });
  await testigo.esperaEstado('Server Unreachable');
  await new Promise((s) => setTimeout(s, 300));
  assert.equal(testigo.dialogos.filter((d) => d.includes('not reachable')).length, 1);
  e.cierra();
});
