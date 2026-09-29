/**
 * Instancia única con acuse y detección de restos de una ejecución anterior.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acusa, escribeFicha, esperaAcuse, leeFicha } from '../src/principal/sistema/instancia.ts';
import { leeListaProcesos, restosDe, vivo } from '../src/principal/sistema/procesos.ts';

const carpeta = mkdtempSync(join(tmpdir(), 'easyhud-instancia-'));
after(() => rmSync(carpeta, { recursive: true, force: true }));

test('ficha: la primera instancia deja su PID', () => {
  escribeFicha(carpeta, 4242, 1000);
  assert.deepEqual(leeFicha(carpeta), { pid: 4242, inicio: 1000 });
  assert.equal(leeFicha(join(carpeta, 'no-existe')), null);
});

test('acuse: la segunda instancia sabe si la primera respondió', async () => {
  const desde = Date.now();
  // Nadie contesta: vence el plazo.
  assert.equal(await esperaAcuse(carpeta, desde, 120, 20), false);
  // La primera contesta al rato.
  setTimeout(() => acusa(carpeta), 60);
  assert.equal(await esperaAcuse(carpeta, desde, 2000, 20), true);
  // Un acuse viejo (de otra vez) no vale.
  assert.equal(await esperaAcuse(carpeta, Date.now() + 10_000, 60, 20), false);
});

const EXE = 'C:\\Program Files\\Easy HUD\\Easy HUD.exe';
const salidaCim = JSON.stringify([
  { ProcessId: 100, ParentProcessId: 1, ExecutablePath: EXE, CommandLine: `"${EXE}"` }, // resto del observador
  { ProcessId: 101, ParentProcessId: 100, ExecutablePath: EXE, CommandLine: `"${EXE}" --type=renderer --foo` }, // su hijo
  { ProcessId: 200, ParentProcessId: 1, ExecutablePath: EXE, CommandLine: `"${EXE}" --auxiliary` }, // el jugador: convive
  { ProcessId: 300, ParentProcessId: 1, ExecutablePath: EXE, CommandLine: `"${EXE}"` }, // éste
  { ProcessId: 400, ParentProcessId: 1, ExecutablePath: 'C:\\otro\\Easy HUD.exe', CommandLine: 'x' }, // otra instalación
  { ProcessId: 'basura' },
]);

test('restos: principales del mismo exe y rol, sin hijos, sin éste y sin el otro rol', () => {
  const lista = leeListaProcesos(salidaCim);
  assert.equal(lista.length, 5);
  const obs = restosDe(lista, { pid: 300, ejecutable: EXE.toLowerCase(), auxiliar: false });
  assert.deepEqual(obs.map((p) => p.pid), [100]);
  const jug = restosDe(lista, { pid: 999, ejecutable: EXE, auxiliar: true });
  assert.deepEqual(jug.map((p) => p.pid), [200]);
});

test('leeListaProcesos: un solo proceso (objeto, no lista), vacío o ilegible', () => {
  assert.equal(leeListaProcesos(JSON.stringify({ ProcessId: 7, ExecutablePath: EXE, CommandLine: '' })).length, 1);
  assert.deepEqual(leeListaProcesos(''), []);
  assert.deepEqual(leeListaProcesos('no json'), []);
});

test('vivo: este proceso sí, uno inventado no', () => {
  assert.equal(vivo(process.pid), true);
  assert.equal(vivo(2 ** 22 + 12345), false);
});
