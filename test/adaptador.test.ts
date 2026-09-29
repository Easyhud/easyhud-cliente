/**
 * Adaptador de GEP contra un gestor de paquetes falso: el vigía del `ready`,
 * el `ready` perdido (la instancia `gep` ya existía al engancharse), el
 * relanzado con actualización pendiente y el reparto de datos.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { vigilaPaquetes, VALORANT, type GestorPaquetes, type ReceptorGep } from '../src/principal/gep/adaptador.ts';

class GepFalso extends EventEmitter {
  features: unknown[] = [];
  falla = false;
  setRequiredFeatures(id: number, f: string[]) {
    this.features.push([id, f]);
    return this.falla ? Promise.reject(new Error('no')) : Promise.resolve();
  }
}

class GestorFalso extends EventEmitter {
  instancia: GepFalso | undefined;
  pendiente = false;
  relanzados = 0;
  get gep() {
    return this.instancia as never;
  }
  hasPendingUpdates() {
    return { hasPendingUpdate: this.pendiente, details: [] };
  }
  relaunch() {
    this.relanzados += 1;
  }
  listo(version = '300.0.0') {
    this.instancia ??= new GepFalso();
    this.emit('ready', {}, 'gep', version);
  }
}

function receptor() {
  const r = {
    estados: [] as string[],
    listos: [] as string[],
    sinListo: [] as Array<[string, number]>,
    info: [] as unknown[],
    incompatibles: 0,
  };
  const rec: ReceptorGep = {
    estado: (m) => r.estados.push(m),
    listo: (v) => r.listos.push(v),
    info: (d) => r.info.push(d),
    evento: () => undefined,
    versionIncompatible: () => {
      r.incompatibles += 1;
    },
    sinListo: (m, i) => r.sinListo.push([m, i]),
    log: () => undefined,
    error: () => undefined,
  };
  return { r, rec };
}

const espera = (ms: number) => new Promise((s) => setTimeout(s, ms));
const comoGestor = (g: GestorFalso) => g as unknown as GestorPaquetes;

test('ready normal: se anuncia, se fijan las features y el vigía no salta', async () => {
  const g = new GestorFalso();
  const { r, rec } = receptor();
  const e = vigilaPaquetes(comoGestor(g), rec, { esperaListoMs: 30 });
  g.listo('301.2.0');
  await espera(60);
  assert.deepEqual(r.listos, ['301.2.0']);
  assert.equal(e.listo, true);
  assert.deepEqual(g.instancia?.features, [[VALORANT, ['match_info', 'me', 'game_info']]]);
  assert.deepEqual(r.sinListo, []);
  e.para();
});

test('sin ready en el plazo: estado visible, aviso y relanzado si hay actualización pendiente', async () => {
  const g = new GestorFalso();
  g.pendiente = true;
  const { r, rec } = receptor();
  const e = vigilaPaquetes(comoGestor(g), rec, { esperaListoMs: 20, reavisoMs: 20 });
  await espera(70);
  assert.ok(r.estados.includes('GEP Not Ready'));
  assert.ok(r.sinListo.length >= 2, 'reavisa mientras siga sin llegar');
  assert.deepEqual(r.sinListo[0], ['actualización de paquetes pendiente', 1]);
  assert.equal(g.relanzados, 1, 'se relanza una sola vez');
  // Llega por fin: deja de avisar.
  g.listo();
  const n = r.sinListo.length;
  await espera(50);
  assert.equal(r.sinListo.length, n);
  assert.equal(e.listo, true);
  e.para();
});

test('ready perdido: la instancia ya existía al engancharse y se da por listo tras fijar features', async () => {
  const g = new GestorFalso();
  g.instancia = new GepFalso();
  const { r, rec } = receptor();
  const e = vigilaPaquetes(comoGestor(g), rec, { esperaListoMs: 20 });
  await espera(40);
  assert.deepEqual(r.listos, ['desconocida']);
  assert.deepEqual(r.sinListo, []);
  // Los datos fluyen tras la detección del juego.
  let habilitado = false;
  g.instancia.emit('game-detected', { enable: () => (habilitado = true) }, VALORANT, 'VALORANT');
  g.instancia.emit('new-info-update', {}, VALORANT, { key: 'round_phase', value: 'combat' });
  assert.equal(habilitado, true);
  assert.deepEqual(r.info, [{ key: 'round_phase', value: 'combat' }]);
  e.para();
});

test('ready perdido falso (features rechazadas): no es "versión incompatible", se sigue esperando', async () => {
  const g = new GestorFalso();
  g.instancia = new GepFalso();
  g.instancia.falla = true;
  const { r, rec } = receptor();
  const e = vigilaPaquetes(comoGestor(g), rec, { esperaListoMs: 20 });
  await espera(60);
  assert.equal(r.incompatibles, 0);
  assert.deepEqual(r.listos, []);
  assert.ok(r.sinListo.length >= 1);
  e.para();
});

test('crashed sin recuperación avisa en el acto', async () => {
  const g = new GestorFalso();
  const { r, rec } = receptor();
  const e = vigilaPaquetes(comoGestor(g), rec, { esperaListoMs: 10_000 });
  g.listo();
  g.emit('crashed', {}, false);
  await espera(20);
  assert.ok(r.estados.includes('GEP Crashed'));
  assert.equal(r.sinListo.length, 1);
  e.para();
});
