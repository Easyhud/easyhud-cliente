/**
 * Rama `copia-funcional`: lo que se añadió para que el programa sea «a prueba de errores de operador y de
 * jugador» y para cerrar los pendientes de la auditoría (ráfaga vieja de Overwolf, reintentos de GEP,
 * mensajes humanos, comprobaciones de arranque, restos de un cierre brusco).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { Almacen } from '../src/principal/almacen.ts';
import { Diagnostico, type EstadoRed } from '../src/principal/diagnostico/diagnostico.ts';
import { versionDeEstado, sondeaConVersion } from '../src/principal/diagnostico/sonda.ts';
import { EnlaceIngesta, type Avisos } from '../src/principal/enlace/conexion.ts';
import { motivoAmable, motivoDeFalloDeRed } from '../src/principal/enlace/mensajes.ts';
import { vigilaPaquetes, type GestorPaquetes, type ReceptorGep } from '../src/principal/gep/adaptador.ts';
import type { Accion } from '../src/principal/gep/acciones.ts';
import { TraductorObservador } from '../src/principal/gep/observador.ts';
import { marcadorCompanero } from '../src/principal/gep/transforma.ts';
import { ServidorLocal } from '../src/principal/local/servidor-local.ts';
import {
  ComprobadorArranque,
  evaluaArranque,
  peorNivel,
  problemas,
  textoComprobaciones,
  versionCompatible,
  type DepsArranque,
  type EntradaArranque,
} from '../src/principal/sistema/arranque.ts';
import { fichaEsDeEasyHud } from '../src/principal/sistema/instancia.ts';

const envios = (acciones: Accion[]) =>
  acciones.filter((a): a is Extract<Accion, { tipo: 'envia' }> => a.tipo === 'envia').map((a) => ({ type: a.type, data: a.data }));
const espera = (ms: number) => new Promise((s) => setTimeout(s, ms));

/* ── GEP: transformaciones ─────────────────────────────────────────────── */

test('initialArmor: un `armor` nulo cae a `shield` (como el original); con valor, manda `armor`', () => {
  assert.equal(marcadorCompanero({ armor: null, shield: 25 }).initialArmor, 25);
  assert.equal(marcadorCompanero({ armor: 50, shield: 25 }).initialArmor, 50);
  assert.equal(marcadorCompanero({ armor: 0, shield: 25 }).initialArmor, 0, 'cero es un valor, no ausencia');
  assert.equal(marcadorCompanero({ shield: 25 }).initialArmor, 25);
});

/* ── Observador: la ráfaga vieja de Overwolf ────────────────────────────── */

test('ráfaga vieja: mapa, modo y matchId repetidos en el menú no se mandan ni se reenvían al autenticar', () => {
  const t = new TraductorObservador({ ahora: () => 100 });
  t.juegoDetectado();
  t.info({ key: 'scene', value: 'MainMenu' });
  assert.deepEqual(envios(t.info({ key: 'map', value: 'Bonsai' })), []);
  assert.deepEqual(envios(t.info({ key: 'game_mode', value: '{"mode":"bomb","custom":true}' })), []);
  assert.deepEqual(envios(t.info({ key: 'match_id', value: 'viejo-1' })), []);
  assert.deepEqual(t.alAutenticar(), [], 'nada de la partida anterior al autenticar');
});

test('ráfaga vieja: al llegar la selección de agentes lo retenido pasa a ser lo vigente (GEP no repite lo que no cambia)', () => {
  const t = new TraductorObservador({ ahora: () => 100 });
  t.juegoDetectado();
  t.info({ key: 'scene', value: 'MainMenu' });
  t.info({ key: 'map', value: 'Infinity' });
  t.info({ key: 'game_mode', value: '{"mode":"bomb","custom":true}' });
  t.info({ key: 'match_id', value: 'm-7' });
  const a = t.info({ key: 'scene', value: 'CharacterSelectPersistentLevel' });
  assert.deepEqual(envios(a), [
    { type: 'map', data: 'Infinityy' },
    { type: 'game_mode', data: 'bomb' },
  ]);
  assert.ok(a.some((x) => x.tipo === 'conecta'));
  assert.deepEqual(envios(t.alAutenticar()), [
    { type: 'map', data: 'Infinityy' },
    { type: 'game_mode', data: 'bomb' },
  ]);
  assert.deepEqual(envios(t.evento({ key: 'match_start', value: null })).at(-1), { type: 'match_start', data: 'm-7' });
});

test('ráfaga vieja: un dato nuevo ya vigente gana a lo retenido', () => {
  const t = new TraductorObservador({ ahora: () => 100 });
  t.juegoDetectado();
  t.info({ key: 'scene', value: 'MainMenu' });
  t.info({ key: 'map', value: 'Bonsai' }); // viejo
  t.info({ key: 'scene', value: 'CharacterSelectPersistentLevel' }); // señal viva: promueve Bonsai
  t.info({ key: 'map', value: 'Ascent' }); // el real
  assert.deepEqual(envios(t.alAutenticar()), [{ type: 'map', data: 'Ascent' }]);
});

test('ráfaga vieja: sin señal viva lo retenido se descarta al volver al menú y nunca se promueve tarde', () => {
  let ahora = 100;
  const t = new TraductorObservador({ ahora: () => ahora });
  t.juegoDetectado();
  t.info({ key: 'scene', value: 'MainMenu' });
  t.info({ key: 'map', value: 'Bonsai' });
  ahora += 5000; // la ráfaga pasó y la escena sigue siendo el menú
  t.info({ key: 'round_number', value: 1 });
  assert.deepEqual(t.alAutenticar(), []);
  t.info({ key: 'scene', value: 'MainMenu' }); // otro menú: se vacía
  const a = t.info({ key: 'scene', value: 'CharacterSelectPersistentLevel' });
  assert.deepEqual(envios(a), []);
});

/* ── Adaptador de GEP: reintentos de setRequiredFeatures ─────────────────── */

class GepFalso extends EventEmitter {
  llamadas = 0;
  fallosHasta = 0;
  setRequiredFeatures() {
    this.llamadas += 1;
    return this.llamadas <= this.fallosHasta ? Promise.reject(new Error('aún no')) : Promise.resolve();
  }
}
class GestorFalso extends EventEmitter {
  /** Como el real: la instancia gep sólo existe tras el eady. */
  instancia: GepFalso = new GepFalso();
  existe = false;
  get gep() {
    return (this.existe ? this.instancia : undefined) as never;
  }
  listo(version = '300.0.0') {
    this.existe = true;
    this.emit('ready', {}, 'gep', version);
  }
}
function receptor() {
  const r = { listos: [] as string[], incompatibles: 0, logs: [] as string[] };
  const rec: ReceptorGep = {
    estado: () => undefined,
    listo: (v) => r.listos.push(v),
    info: () => undefined,
    evento: () => undefined,
    versionIncompatible: () => {
      r.incompatibles += 1;
    },
    log: (t) => r.logs.push(t),
    error: () => undefined,
  };
  return { r, rec };
}

test('GEP: un fallo puntual de setRequiredFeatures se reintenta y NO se declara versión incompatible', async () => {
  const g = new GestorFalso();
  g.instancia.fallosHasta = 2;
  const { r, rec } = receptor();
  const e = vigilaPaquetes(g as unknown as GestorPaquetes, rec, { esperaListoMs: 10_000, reintentosFeatures: 3, esperaReintentoFeaturesMs: 5 });
  g.listo();
  await espera(80);
  assert.equal(g.instancia.llamadas, 3);
  assert.equal(r.incompatibles, 0);
  assert.ok(r.logs.some((l) => l.includes('intento 3')));
  e.para();
});

test('GEP: agotados los reintentos sí avisa de versión incompatible (una sola vez)', async () => {
  const g = new GestorFalso();
  g.instancia.fallosHasta = 99;
  const { r, rec } = receptor();
  const e = vigilaPaquetes(g as unknown as GestorPaquetes, rec, { esperaListoMs: 10_000, reintentosFeatures: 3, esperaReintentoFeaturesMs: 5 });
  g.listo();
  await espera(100);
  assert.equal(g.instancia.llamadas, 3);
  assert.equal(r.incompatibles, 1);
  e.para();
});

/* ── Mensajes humanos ───────────────────────────────────────────────────── */

test('motivoAmable: «Invalid packet» no se confunde con credenciales; el resto de rechazos del servidor siguen igual', () => {
  assert.match(motivoAmable('Invalid packet.'), /did not understand/);
  assert.match(motivoAmable('Invalid Key'), /didn't accept/);
  assert.match(motivoAmable('Expired Key'), /expired/);
});

test('motivoDeFalloDeRed: qué pasó y qué hacer para servidor caído, sin internet, tiempo agotado y certificado', () => {
  const caido = motivoDeFalloDeRed('Error: xhr poll error { code: ECONNREFUSED }');
  assert.ok(caido?.servidorCaido);
  assert.match(caido.titulo, /not reachable/);
  assert.match(motivoDeFalloDeRed('getaddrinfo ENOTFOUND servidor')?.titulo ?? '', /No internet/);
  assert.match(motivoDeFalloDeRed('connect ETIMEDOUT 1.2.3.4:5100')?.titulo ?? '', /does not answer/);
  assert.match(motivoDeFalloDeRed('unable to verify the first certificate')?.titulo ?? '', /Secure connection/);
  assert.equal(motivoDeFalloDeRed('algo raro'), null);
});

test('conexión: un fallo de red que no es «puerto cerrado» también avisa UNA vez, con qué hacer', () => {
  const falso = Object.assign(new EventEmitter(), { io: new EventEmitter(), active: true, connect() {}, disconnect() {}, close() {} });
  const dialogos: string[] = [];
  const estados: string[] = [];
  const avisos: Avisos = {
    estado: (m) => estados.push(m),
    dialogo: (t, m) => dialogos.push(`${t}: ${m}`),
    autenticado: () => undefined,
    desconectado: () => undefined,
    log: () => undefined,
  };
  const enlace = new EnlaceIngesta({ version: '0.3.14', avisos, crearSocket: () => falso as unknown as Socket });
  enlace.abre('http://x:1', { rol: 'observador', token: 't', grupo: 'g' });
  const fallo = Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' });
  falso.emit('connect_error', fallo);
  falso.emit('connect_error', fallo);
  assert.equal(dialogos.length, 1);
  assert.match(dialogos[0], /No internet connection/);
  assert.equal(estados.at(-1), 'Connection Closed');
});

/* ── Comprobaciones de arranque ─────────────────────────────────────────── */

function entrada(sobre: Partial<EntradaArranque> = {}): EntradaArranque {
  return {
    rol: 'jugador',
    version: '0.3.14',
    riot: 'ok',
    valorant: { abierto: true, yaAbiertoAlArrancar: false, detectado: true },
    gep: 'listo',
    gepVersion: '300.1.0',
    eventosOverwolf: null,
    servidor: { ok: true, causa: '', arreglo: '', version: '0.3.9' },
    conflictos: [],
    overwolfEscritorio: 0,
    entorno: { esAdmin: false, valorantElevado: false, desdeTemporal: false },
    privilegiosRequeridos: false,
    ...sobre,
  };
}
const ids = (l: ReturnType<typeof evaluaArranque>, nivel?: string) => l.filter((c) => nivel === undefined || c.nivel === nivel).map((c) => c.id);

test('arranque: todo bien no produce avisos ni errores', () => {
  const l = evaluaArranque(entrada());
  assert.equal(peorNivel(l), 'ok');
  assert.deepEqual(problemas(l), []);
  assert.ok(ids(l).includes('riot') && ids(l).includes('servidor') && ids(l).includes('version'));
});

test('arranque: Riot Client cerrado o sin sesión (aviso al jugador, sólo pista al observador)', () => {
  const j = evaluaArranque(entrada({ riot: 'cerrado' })).find((c) => c.id === 'riot');
  assert.equal(j?.nivel, 'aviso');
  assert.match(j?.arreglo ?? '', /sign in/);
  assert.equal(evaluaArranque(entrada({ riot: 'sin-sesion' })).find((c) => c.id === 'riot')?.titulo, 'Riot Client: not signed in');
  assert.equal(evaluaArranque(entrada({ rol: 'observador', riot: 'cerrado' })).find((c) => c.id === 'riot')?.nivel, 'info');
});

test('arranque: VALORANT abierto antes que Easy HUD y sin detectar → orden incorrecto', () => {
  const l = evaluaArranque(entrada({ valorant: { abierto: true, yaAbiertoAlArrancar: true, detectado: false } }));
  const c = l.find((x) => x.id === 'orden');
  assert.equal(c?.nivel, 'aviso');
  assert.match(c?.arreglo ?? '', /Easy HUD first/);
  // Si Overwolf sí lo detectó, el orden no importó.
  assert.equal(evaluaArranque(entrada({ valorant: { abierto: true, yaAbiertoAlArrancar: true, detectado: true } })).some((x) => x.id === 'orden'), false);
  // VALORANT cerrado: pista de que se abra DESPUÉS.
  const cerrado = evaluaArranque(entrada({ valorant: { abierto: false, yaAbiertoAlArrancar: false, detectado: false } })).find((x) => x.id === 'valorant');
  assert.equal(cerrado?.nivel, 'info');
});

test('arranque: GEP caído es error; esperando es sólo pista; eventos de Overwolf en rojo es error', () => {
  assert.ok(ids(evaluaArranque(entrada({ gep: 'caido' })), 'error').includes('gep'));
  assert.ok(ids(evaluaArranque(entrada({ gep: 'esperando' })), 'info').includes('gep'));
  assert.ok(ids(evaluaArranque(entrada({ eventosOverwolf: 3 })), 'error').includes('eventos'));
  assert.ok(ids(evaluaArranque(entrada({ eventosOverwolf: 2 })), 'aviso').includes('eventos'));
  assert.equal(evaluaArranque(entrada({ eventosOverwolf: null })).some((c) => c.id === 'eventos'), false);
});

test('arranque: servidor inaccesible es error con causa y arreglo; versión que no casa es error', () => {
  const sin = evaluaArranque(entrada({ servidor: { ok: false, causa: 'Server port: port 5100 does not answer', arreglo: 'Allow Easy HUD in the firewall', version: '' } }));
  const c = sin.find((x) => x.id === 'servidor');
  assert.equal(c?.nivel, 'error');
  assert.match(c?.detalle ?? '', /port 5100/);
  assert.match(c?.arreglo ?? '', /firewall/);
  const v = evaluaArranque(entrada({ version: '0.3.14', servidor: { ok: true, causa: '', arreglo: '', version: '0.4.0' } })).find((x) => x.id === 'version');
  assert.equal(v?.nivel, 'error');
  assert.match(v?.arreglo ?? '', /latest/);
  assert.equal(versionCompatible('0.3.14', '0.3.9'), true);
  assert.equal(versionCompatible('0.3.14', '1.0.0'), false);
  assert.equal(versionCompatible('0.3.14', 'rara'), null);
});

test('arranque: otro programa compitiendo (error) y Overwolf de escritorio (aviso)', () => {
  assert.ok(ids(evaluaArranque(entrada({ conflictos: ['EasyHUD.exe (pid 9)'] })), 'error').includes('conflicto'));
  assert.ok(ids(evaluaArranque(entrada({ overwolfEscritorio: 1 })), 'aviso').includes('conflicto'));
});

test('arranque: VALORANT como administrador y Easy HUD no (o GEP lo pidió) es error con el arreglo exacto', () => {
  const c = evaluaArranque(entrada({ entorno: { esAdmin: false, valorantElevado: true, desdeTemporal: false } })).find((x) => x.id === 'admin');
  assert.equal(c?.nivel, 'error');
  assert.match(c?.arreglo ?? '', /Run as administrator/);
  assert.ok(ids(evaluaArranque(entrada({ privilegiosRequeridos: true })), 'error').includes('admin'));
  // Easy HUD elevado y VALORANT no: Overwolf lee igual.
  assert.equal(evaluaArranque(entrada({ entorno: { esAdmin: true, valorantElevado: false, desdeTemporal: false } })).find((x) => x.id === 'admin')?.nivel, 'ok');
  assert.ok(ids(evaluaArranque(entrada({ entorno: { esAdmin: false, valorantElevado: false, desdeTemporal: true } })), 'aviso').includes('temporal'));
});

test('arranque: el texto lista primero los errores y trae «qué hacer»', () => {
  const l = evaluaArranque(entrada({ riot: 'cerrado', conflictos: ['otro.exe (pid 1)'] }));
  const texto = textoComprobaciones(l, true);
  assert.ok(texto.indexOf('FAIL') < texto.indexOf('WARN'));
  assert.match(texto, /→ /);
  assert.equal(texto.includes('OK   '), false, 'sólo problemas');
  assert.match(textoComprobaciones(l), /OK   /);
});

test('ComprobadorArranque: «VALORANT ya abierto al arrancar» se fija con la primera lectura y no cambia después', async () => {
  let abierto = true;
  let detectado = false;
  const deps: DepsArranque = {
    rol: 'jugador',
    version: '0.3.14',
    riot: async () => 'ok',
    valorantAbierto: async () => abierto,
    entorno: async () => ({ esAdmin: false, valorantElevado: false, desdeTemporal: false }),
    conflictos: async () => ({ conflictos: [], overwolfEscritorio: 0 }),
    servidor: async () => ({ ok: true, causa: '', arreglo: '', version: '0.3.9' }),
    gep: () => ({ estado: 'listo', version: '1', detectado }),
    eventosOverwolf: () => null,
    privilegiosRequeridos: () => false,
  };
  const c = new ComprobadorArranque(deps);
  assert.ok((await c.ejecuta()).some((x) => x.id === 'orden'), 'abierto desde antes y sin detectar');
  detectado = true;
  assert.equal((await c.ejecuta()).some((x) => x.id === 'orden'), false, 'ya detectado: da igual el orden');
  abierto = false;
  detectado = false;
  await c.ejecuta();
  abierto = true; // lo abrió después: ya no cuenta como «antes»
  assert.equal((await c.ejecuta()).some((x) => x.id === 'orden'), false);
});

test('ComprobadorArranque: una fuente que falla no tumba la pasada', async () => {
  const deps: DepsArranque = {
    rol: 'observador',
    version: '0.3.14',
    riot: async () => {
      throw new Error('x');
    },
    valorantAbierto: async () => false,
    entorno: async () => {
      throw new Error('powershell');
    },
    conflictos: async () => ({ conflictos: [], overwolfEscritorio: 0 }),
    servidor: async () => null,
    gep: () => ({ estado: 'esperando', version: '', detectado: false }),
    eventosOverwolf: () => null,
    privilegiosRequeridos: () => false,
  };
  const l = await new ComprobadorArranque(deps).ejecuta();
  assert.ok(l.length > 0);
  assert.equal(l.some((c) => c.id === 'riot'), false);
});

test('diagnóstico del jugador: las comprobaciones sin alerta propia (admin, orden…) salen como alertas; las demás no se duplican', () => {
  const d = new Diagnostico('0.3.14', () => 1_000);
  const red: EstadoRed = { conectada: true, desdeMs: 1000, conectoAlgunaVez: true, latiendo: true, oidoPorServidor: true, ultimoFallo: '', intentos: 0 };
  d.fijaComprobaciones(
    evaluaArranque(entrada({ conflictos: ['otro.exe (pid 1)'], entorno: { esAdmin: false, valorantElevado: true, desdeTemporal: false } })),
  );
  const alertas = d.alertas(red);
  assert.ok(alertas.some((a) => a.id === 'arranque-admin' && a.nivel === 'error'));
  assert.equal(alertas.some((a) => a.id === 'arranque-conflicto'), false, 'el conflicto ya tiene su alerta propia (fijaConflictos)');
});

/* ── Sonda del servidor ─────────────────────────────────────────────────── */

test('versionDeEstado lee la versión del /status y tolera basura', () => {
  assert.equal(versionDeEstado('{"status":"UP","version":"0.3.9"}'), '0.3.9');
  assert.equal(versionDeEstado('no json'), '');
  assert.equal(versionDeEstado('{"status":"UP"}'), '');
});

test('sondeaConVersion: lee la versión de un servidor real y avisa si no responde', async () => {
  const http = createServer((_q, r) => r.end(JSON.stringify({ status: 'UP', version: '0.3.9' })));
  await new Promise<void>((s) => http.listen(0, '127.0.0.1', s));
  const puerto = (http.address() as { port: number }).port;
  try {
    const ok = await sondeaConVersion(`http://127.0.0.1:${puerto}/status`, 2000);
    assert.deepEqual(ok, { ok: true, motivo: '', version: '0.3.9' });
  } finally {
    await new Promise<void>((s) => http.close(() => s()));
  }
  const mal = await sondeaConVersion(`http://127.0.0.1:${puerto}/status`, 1000);
  assert.equal(mal.ok, false);
  assert.match(mal.motivo, /refused|network error|did not answer|cut/);
});

/* ── Restos de un cierre brusco ─────────────────────────────────────────── */

test('la ficha de una instancia anterior sólo cuenta si ese PID sigue siendo Easy HUD (los PID se reutilizan)', () => {
  const lista = [
    { pid: 10, padre: 1, ruta: 'C:\\Users\\x\\AppData\\Local\\Programs\\Easy HUD\\Easy HUD.exe', orden: '' },
    { pid: 11, padre: 1, ruta: 'C:\\Windows\\System32\\notepad.exe', orden: '' },
    { pid: 12, padre: 1, ruta: '', orden: '' },
  ];
  const yo = 'C:\\Apps\\Easy HUD\\Easy HUD.exe';
  assert.equal(fichaEsDeEasyHud(lista, 10, yo), true);
  assert.equal(fichaEsDeEasyHud(lista, 11, yo), false, 'otro programa con el PID reutilizado');
  assert.equal(fichaEsDeEasyHud(lista, 12, yo), false, 'sin ruta no se puede asegurar');
  assert.equal(fichaEsDeEasyHud(lista, 99, yo), false, 'ya no existe');
});

test('almacén: los .tmp de un cierre brusco se limpian sin tocar los ficheros buenos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-alm-'));
  try {
    const a = new Almacen(dir);
    await a.escribe('playerId', { playerId: 'p1' });
    writeFileSync(join(a.carpeta, 'matchSecret.json.123.tmp'), '{"secret":"a med');
    writeFileSync(join(a.carpeta, 'otro.json.456.tmp'), 'x');
    assert.equal(a.limpiaTemporales(), 2);
    assert.equal(a.lee('playerId').playerId, 'p1');
    assert.equal(existsSync(join(a.carpeta, 'otro.json.456.tmp')), false);
    assert.equal(a.limpiaTemporales(), 0);
    assert.equal(new Almacen(join(dir, 'no-existe')).limpiaTemporales(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('almacén: un JSON truncado por un apagón se lee como vacío en vez de romper el arranque', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-alm-'));
  try {
    const a = new Almacen(dir);
    await a.escribe('x', {});
    writeFileSync(a.ruta('grupoJugador'), '{"grupo":"AB');
    assert.deepEqual(a.lee('grupoJugador'), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('servidor local: puerto ocupado → se reintenta y, si sigue ocupado, avisa con qué hacer (OBS no se queda ciego en silencio)', async () => {
  const ocupa = createServer();
  await new Promise<void>((s) => ocupa.listen(0, '127.0.0.1', s));
  const puerto = (ocupa.address() as { port: number }).port;
  const avisos: string[] = [];
  const logs: string[] = [];
  const raiz = mkdtempSync(join(tmpdir(), 'easy-raiz-'));
  try {
    const s = new ServidorLocal({ raiz, puerto, log: (t) => logs.push(t), alFallar: (t) => avisos.push(t), intentosPuerto: 3, esperaPuertoMs: 5 });
    await s.arranca({ endpoint: 'http://127.0.0.1:1', token: 't', grupo: 'G' });
    assert.equal(s.enMarcha, false);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], new RegExp(`Port ${puerto} is already in use`));
    assert.match(avisos[0], /Reconnect everything/);
    assert.equal(logs.filter((l) => l.includes('no arranca')).length, 3, 'tres intentos');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    await new Promise<void>((s) => ocupa.close(() => s()));
  }
});

test('servidor local: si el puerto se libera entre intentos, arranca sin avisar', async () => {
  const ocupa = createServer();
  await new Promise<void>((s) => ocupa.listen(0, '127.0.0.1', s));
  const puerto = (ocupa.address() as { port: number }).port;
  const avisos: string[] = [];
  const raiz = mkdtempSync(join(tmpdir(), 'easy-raiz-'));
  const s = new ServidorLocal({ raiz, puerto, log: () => undefined, alFallar: (t) => avisos.push(t), intentosPuerto: 6, esperaPuertoMs: 40 });
  try {
    setTimeout(() => ocupa.close(), 60);
    await s.arranca({ endpoint: 'http://127.0.0.1:1', token: 't', grupo: 'G' });
    assert.equal(s.enMarcha, true);
    assert.deepEqual(avisos, []);
  } finally {
    await s.para();
    rmSync(raiz, { recursive: true, force: true });
  }
});
