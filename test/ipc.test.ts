/**
 * El contrato del puente con el panel.
 *
 * Se carga el preload de verdad con un módulo `electron` falso y se comprueba
 * que cada método que llama `overlay/panel/js/shell.js` existe, usa el canal
 * acordado con el tipo correcto (síncrono, envío, invocación o suscripción) y
 * que los manejadores `db:*` responden con la forma esperada.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Almacen } from '../src/principal/almacen.ts';
import { CANALES, canalDb, enlaceExternoPermitido, manejadoresDb } from '../src/principal/canales.ts';
import { creaColecciones } from '../src/principal/coleccion.ts';

type Llamada = { tipo: 'sendSync' | 'send' | 'invoke' | 'on'; canal: string; args: unknown[] };
const llamadas: Llamada[] = [];
const oyentes = new Map<string, (e: unknown, d: unknown) => void>();
let api: Record<string, (...args: unknown[]) => unknown> = {};

const electronFalso = {
  contextBridge: {
    exposeInMainWorld: (nombre: string, objeto: Record<string, (...args: unknown[]) => unknown>) => {
      assert.equal(nombre, 'electronAPI');
      api = objeto;
    },
  },
  ipcRenderer: {
    sendSync: (canal: string, ...args: unknown[]) => {
      llamadas.push({ tipo: 'sendSync', canal, args });
      return `sync:${canal}`;
    },
    send: (canal: string, ...args: unknown[]) => llamadas.push({ tipo: 'send', canal, args }),
    invoke: (canal: string, ...args: unknown[]) => {
      llamadas.push({ tipo: 'invoke', canal, args });
      return Promise.resolve({ canal });
    },
    on: (canal: string, fn: (e: unknown, d: unknown) => void) => {
      llamadas.push({ tipo: 'on', canal, args: [] });
      oyentes.set(canal, fn);
    },
    removeListener: () => undefined,
  },
};

// Carga el preload interceptando `require('electron')`.
const cargaOriginal = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (peticion: unknown, ...resto: unknown[]) {
  if (peticion === 'electron') return electronFalso;
  return cargaOriginal.call(this, peticion, ...resto);
};
createRequire(import.meta.url)('../src/preload/puente.cts');
(Module as unknown as { _load: unknown })._load = cargaOriginal;

const ultima = () => llamadas.at(-1);

test('el preload expone exactamente los métodos que usa el panel', () => {
  const shell = readFileSync(new URL('../../overlay/panel/js/shell.js', import.meta.url), 'utf8');
  const acceso = readFileSync(new URL('../../overlay/panel/js/acceso.js', import.meta.url), 'utf8');
  const usados = new Set<string>();
  for (const m of shell.matchAll(/api\(\)\?\.(\w+)\?\./g)) usados.add(m[1]);
  for (const m of acceso.matchAll(/electronAPI\?\.(\w+)\?\./g)) usados.add(m[1]);
  // Los de la base se construyen como `db${pre}List`… (shell.js:126-129).
  for (const pre of ['Teams', 'Matches', 'Tournaments']) for (const op of ['List', 'Create', 'Update', 'Delete']) usados.add(`db${pre}${op}`);
  for (const nombre of usados) assert.equal(typeof api[nombre], 'function', `falta electronAPI.${nombre}`);
  assert.deepEqual(Object.keys(api).sort(), [...usados].sort());
});

test('métodos síncronos y de envío → su canal', () => {
  assert.equal(api.getBuildProfile(), `sync:${CANALES.perfil}`);
  assert.equal(api.getObsUrl(), `sync:${CANALES.urlObs}`);

  const envios: Array<[string, unknown[], string, unknown[]]> = [
    ['conecta', ['tok', 'grp'], CANALES.conecta, ['tok', 'grp']],
    ['arrancaOverlayLocal', ['tok', 'grp'], CANALES.arrancaOverlay, ['tok', 'grp']],
    ['paraOverlayLocal', [], CANALES.paraOverlay, []],
    ['arrancaLectorSala', [], CANALES.arrancaSala, []],
    ['paraLectorSala', [], CANALES.paraSala, []],
    ['aplicaAtajos', [{ enabled: {} }], CANALES.aplicaAtajos, [{ enabled: {} }]],
    ['suspendeAtajos', [], CANALES.suspendeAtajos, []],
    ['operadorOverlay', [true], CANALES.operador, [true]],
    ['operadorOverlay', ['no-booleano'], CANALES.operador, [false]],
    ['ventanaMinimizar', [], CANALES.minimizar, []],
    ['ventanaMaximizar', [], CANALES.maximizar, []],
    ['ventanaCerrar', [], CANALES.cerrar, []],
    ['openExternalLink', ['https://easyhud.net'], CANALES.enlaceExterno, ['https://easyhud.net']],
  ];
  for (const [metodo, args, canal, esperados] of envios) {
    api[metodo](...args);
    assert.deepEqual(ultima(), { tipo: 'send', canal, args: esperados }, metodo);
  }
});

test('invocaciones → su canal; llamaJugadores(null) manda lista vacía', async () => {
  await api.creaSalaTorneo();
  assert.deepEqual(ultima(), { tipo: 'invoke', canal: CANALES.creaSala, args: [] });
  await api.llamaJugadores(['a', 'b']);
  assert.deepEqual(ultima(), { tipo: 'invoke', canal: CANALES.llamaJugadores, args: [['a', 'b']] });
  await api.llamaJugadores(null);
  assert.deepEqual(ultima(), { tipo: 'invoke', canal: CANALES.llamaJugadores, args: [[]] });

  for (const [pre, col] of [
    ['Teams', 'teams'],
    ['Matches', 'matches'],
    ['Tournaments', 'tournaments'],
  ] as const) {
    await api[`db${pre}List`]();
    assert.deepEqual(ultima(), { tipo: 'invoke', canal: canalDb(col, 'list'), args: [] });
    await api[`db${pre}Create`]({ name: 'x' });
    assert.deepEqual(ultima(), { tipo: 'invoke', canal: canalDb(col, 'create'), args: [{ name: 'x' }] });
    await api[`db${pre}Update`]('id', { name: 'y' });
    assert.deepEqual(ultima(), { tipo: 'invoke', canal: canalDb(col, 'update'), args: ['id', { name: 'y' }] });
    await api[`db${pre}Delete`]('id');
    assert.deepEqual(ultima(), { tipo: 'invoke', canal: canalDb(col, 'delete'), args: ['id'] });
  }
});

test('suscripciones: onEscena entrega sólo el mensaje; onSerieFin y onSalaLocal tal cual', () => {
  const recibido: unknown[] = [];
  api.onEscena((m: unknown) => recibido.push(m));
  api.onSerieFin((d: unknown) => recibido.push(d));
  api.onSalaLocal((s: unknown) => recibido.push(s));
  oyentes.get(CANALES.estadoJuego)?.({}, { message: 'Agent Select', statusType: 'success' });
  oyentes.get(CANALES.estadoJuego)?.({}, null);
  oyentes.get(CANALES.serieFin)?.({}, { ganador: 0 });
  oyentes.get(CANALES.salaLocal)?.({}, null);
  assert.deepEqual(recibido, ['Agent Select', '', { ganador: 0 }, null]);
});

/* ── Manejadores de la base ─────────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'easyhud-ipc-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('db:*: doce canales y respuestas {ok, items|item|error}', async () => {
  const m = manejadoresDb(creaColecciones(new Almacen(dir)));
  assert.equal(m.size, 12);
  const llama = (canal: string, ...args: unknown[]) => (m.get(canal) as (...a: unknown[]) => Promise<unknown>)(...args);

  assert.deepEqual(await llama('db:teams:list'), { ok: true, items: [] });
  const creado = (await llama('db:teams:create', { name: 'Rojos' })) as { ok: boolean; item: { id: string } };
  assert.equal(creado.ok, true);
  const lista = (await llama('db:teams:list')) as { items: unknown[] };
  assert.equal(lista.items.length, 1);
  const cambiado = (await llama('db:teams:update', creado.item.id, { name: 'Rojos 2' })) as { ok: boolean; item: { name: string } };
  assert.equal(cambiado.ok, true);
  assert.equal(cambiado.item.name, 'Rojos 2');
  assert.deepEqual(await llama('db:teams:update', 'nada', {}), { ok: false, error: 'No existe.' });
  assert.deepEqual(await llama('db:teams:delete', creado.item.id), { ok: true });
  assert.deepEqual(await llama('db:teams:delete', creado.item.id), { ok: false });
  assert.deepEqual(await llama('db:tournaments:list'), { ok: true, items: [] });
});

test('db:*: una excepción vuelve como {ok: false, error}', async () => {
  const rota = {
    list: () => {
      throw new Error('disco roto');
    },
  };
  const m = manejadoresDb({ teams: rota, matches: rota, tournaments: rota } as never);
  assert.deepEqual(await (m.get('db:matches:list') as () => Promise<unknown>)(), { ok: false, error: 'disco roto' });
});

test('open-external-link: sólo https', () => {
  assert.equal(enlaceExternoPermitido('https://easyhud.net/x'), true);
  assert.equal(enlaceExternoPermitido('http://easyhud.net'), false);
  assert.equal(enlaceExternoPermitido('file:///C:/Windows/system32/calc.exe'), false);
  assert.equal(enlaceExternoPermitido('javascript:alert(1)'), false);
  assert.equal(enlaceExternoPermitido(42), false);
});
