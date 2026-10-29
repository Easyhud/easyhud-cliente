/**
 * Rama `copia-funcional`, segunda pasada de auditoría frente a ValoSpectra/Spectra-Client: datos de GEP que
 * cambian entre versiones, teclas globales (choques) y piezas que evitan que el programa se quede colgado.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, Agent } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOMBRES_MANDOS,
  normalizaTecla,
  planAtajos,
  separaChoques,
  textoAtajosFallidos,
  type PlanAtajos,
} from '../src/principal/atajos.ts';
import type { Accion } from '../src/principal/gep/acciones.ts';
import { TraductorJugador } from '../src/principal/gep/jugador.ts';
import { TraductorObservador } from '../src/principal/gep/observador.ts';
import { booleano, esEquipoObservador, killfeed, marcador, marcadorCompanero, roster } from '../src/principal/gep/transforma.ts';
import { ServidorLocal } from '../src/principal/local/servidor-local.ts';
import { compruebaActualizacion, evalua } from '../src/principal/sistema/actualizaciones.ts';
import { conLimite, ejecutaPasos, FiltroDialogos, LimitadorRecargas, padreDeDialogo } from '../src/principal/sistema/robustez.ts';

const envios = (acciones: Accion[]) =>
  acciones.filter((a): a is Extract<Accion, { tipo: 'envia' }> => a.tipo === 'envia').map((a) => ({ type: a.type, data: a.data }));

/* ── GEP: claves y formatos que cambian entre versiones ─────────────────── */

test('spike: booleano, texto TX_Hud_Bomb_S, "true" en texto; todo lo demás es «no lo lleva»', () => {
  const spike = (s: unknown) => marcadorCompanero({ spike: s }).hasSpike;
  assert.equal(spike(true), true);
  assert.equal(spike(false), false);
  assert.equal(spike('TX_Hud_Bomb_S'), true);
  assert.equal(spike('true'), true);
  assert.equal(spike(''), false);
  assert.equal(spike(null), false);
  assert.equal(spike(undefined), false);
  assert.equal(spike('TX_Hud_Bomb_Empty'), false);
});

test('booleanos de GEP en texto: "false" no cuenta como vivo; lo demás pasa tal cual', () => {
  assert.equal(booleano('false'), false);
  assert.equal(booleano('true'), true);
  assert.equal(booleano(true), true);
  assert.equal(booleano(undefined), undefined);
  assert.equal(booleano(null), null);
  assert.equal(marcador({ name: 'A #1', alive: 'false', team: 0 }).isAlive, false);
  assert.equal(marcador({ name: 'A #1', alive: 'true', team: 0 }).isAlive, true);
  assert.equal(roster({ name: 'A #1', locked: 'true' }, 'roster_2').locked, true);
  const k = killfeed({ attacker: 'a', victim: 'b', weapon: 'w', headshot: 'false', is_victim_teammate: 'true' });
  assert.equal(k.headshotKill, false);
  assert.equal(k.isTeamkill, true);
});

test('armor/shield: shield nulo con armor ausente no inventa un número', () => {
  assert.equal(marcadorCompanero({ shield: 25 }).initialArmor, 25);
  assert.equal(marcadorCompanero({ armor: 50 }).initialArmor, 50);
  assert.equal(marcadorCompanero({ armor: null, shield: null }).initialArmor, null);
});

test('team observer: cualquier combinación de mayúsculas, sólo texto', () => {
  assert.equal(esEquipoObservador('observer'), true);
  assert.equal(esEquipoObservador('Observer'), true);
  assert.equal(esEquipoObservador(' OBSERVER '), true);
  assert.equal(esEquipoObservador('attacker'), false);
  assert.equal(esEquipoObservador(null), false);
  assert.equal(esEquipoObservador(1), false);
  const o = new TraductorObservador();
  o.info({ key: 'team', value: 'Observer' });
  assert.equal(o.esObservador, true);
  const j = new TraductorJugador();
  j.procesa({ key: 'scene', value: 'Ascent' });
  j.procesa({ key: 'team', value: 'Observer' });
  assert.equal(j.soyEspectador, true);
});

test('observador: game_mode sin modo o con modo vacío se ignora (no se manda ni borra el anterior)', () => {
  const t = new TraductorObservador({ ahora: () => 10_000 });
  t.info({ key: 'scene', value: 'CharacterSelectPersistentLevel' });
  assert.deepEqual(envios(t.info({ key: 'game_mode', value: '{"mode":"bomb","custom":true}' })), [{ type: 'game_mode', data: 'bomb' }]);
  for (const v of ['{"mode":"","custom":true}', '{"custom":true}', '{"mode":null}', 'no es json', null, 'open']) {
    assert.deepEqual(envios(t.info({ key: 'game_mode', value: v })), [], String(v));
  }
  assert.deepEqual(t.modoDeJuego, { modo: 'bomb', custom: true }, 'el modo bueno sigue vigente');
});

test('observador: null, open/closed, JSON inválido y objetos ya analizados no rompen nada ni se mandan como datos', () => {
  const t = new TraductorObservador({ ahora: () => 10_000 });
  t.info({ key: 'scene', value: 'CharacterSelectPersistentLevel' });
  for (const key of ['scoreboard_0', 'roster_0', 'kill_feed', 'match_score', 'game_mode']) {
    for (const v of [null, undefined, 'open', 'closed', 'close', '{no json', '[]', '"texto"', '']) {
      assert.deepEqual(envios(t.info({ key, value: v })), [], `${key} ${String(v)}`);
    }
  }
  // Un valor ya analizado (objeto) entra igual que su texto JSON.
  const marc = envios(t.info({ key: 'scoreboard_3', value: { name: 'Ana #EUW', player_id: 'p1', team: 1, alive: true } }));
  assert.equal(marc.length, 1);
  assert.equal((marc[0].data as { name: string }).name, 'Ana');
});

/* ── Teclas globales: choques ───────────────────────────────────────────── */

const plan = (teclas: Record<string, string>): PlanAtajos => {
  const p = planAtajos({
    spikePlanted: 'F9',
    techPause: 'F10',
    leftTimeout: 'O',
    rightTimeout: 'P',
    switchKdaCredits: 'I',
    ...teclas,
    enabled: { spikePlanted: true, techPause: true, leftTimeout: true, rightTimeout: true, switchKdaCredits: true },
  });
  assert.notEqual(p, null);
  return p as PlanAtajos;
};

test('teclas: la forma canónica ignora mayúsculas, Control/Ctrl y el orden de los modificadores', () => {
  assert.equal(normalizaTecla('Ctrl+Alt+K'), normalizaTecla('alt+control+k'));
  assert.equal(normalizaTecla('Shift+Ctrl+f9'), 'ctrl+shift+f9');
  assert.notEqual(normalizaTecla('Ctrl+K'), normalizaTecla('K'));
  assert.equal(normalizaTecla('o'), normalizaTecla('O'));
});

test('teclas: sin choques todo queda libre y en su orden', () => {
  const r = separaChoques(plan({}).registros);
  assert.equal(r.libres.length, 5);
  assert.deepEqual(r.choques, []);
});

test('teclas: dos mandos con la misma tecla (aunque se escriba distinto) — el primero se queda con ella', () => {
  const r = separaChoques(plan({ rightTimeout: 'o', switchKdaCredits: 'Ctrl+Alt+K', techPause: 'Alt+Ctrl+k' }).registros);
  assert.deepEqual(
    r.libres.map((x) => x.mando),
    ['spikePlanted', 'techPause', 'leftTimeout'],
  );
  assert.equal(r.choques.length, 2);
  assert.equal(r.choques[0].mando, 'rightTimeout');
  assert.match(r.choques[0].motivo, /already used for "Left timeout"/);
  assert.equal(r.choques[1].mando, 'switchKdaCredits');
  assert.match(r.choques[1].motivo, /already used for "Tech pause"/);
});

test('teclas: las combinaciones del propio programa (Ctrl+Alt+O / Ctrl+Alt+R) no se ofrecen a los mandos', () => {
  const r = separaChoques(plan({ leftTimeout: 'Ctrl+Alt+R', rightTimeout: 'Ctrl+Alt+O' }).registros);
  assert.deepEqual(
    r.libres.map((x) => x.mando),
    ['spikePlanted', 'techPause', 'switchKdaCredits'],
  );
  assert.equal(r.choques.length, 2);
  assert.match(r.choques[0].motivo, /reserved by Easy HUD \(Reconnect everything\)/);
  assert.match(r.choques[1].motivo, /reserved by Easy HUD \(the operator overlay\)/);
});

test('teclas: el aviso junta todas las causas en un solo texto en inglés, o es null si no hay nada', () => {
  assert.equal(textoAtajosFallidos({ ocupadas: [], ilegales: [], choques: [], invalidas: [] }), null);
  const libres = plan({}).registros;
  const texto = textoAtajosFallidos({
    ocupadas: [libres[0]],
    ilegales: [libres[1]],
    choques: [{ mando: 'leftTimeout', tecla: 'O', motivo: 'O is already used for "Right timeout"' }],
    invalidas: ['XX'],
  });
  assert.ok(texto !== null);
  assert.match(texto, /will NOT work/);
  assert.match(texto, new RegExp(`${NOMBRES_MANDOS.spikePlanted}: F9 is already used by another program`));
  assert.match(texto, /Tech pause: F10 cannot be used as a global hotkey/);
  assert.match(texto, /Left timeout: O is already used for "Right timeout"/);
  assert.match(texto, /XX is not a valid hotkey/);
  assert.match(texto, /Change them in the panel/);
});

/* ── Robustez: diálogos, ventana, pasos ─────────────────────────────────── */

const ventana = (o: Partial<{ destruida: boolean; visible: boolean; minimizada: boolean }> = {}) => ({
  isDestroyed: () => o.destruida ?? false,
  isVisible: () => o.visible ?? true,
  isMinimized: () => o.minimizada ?? false,
});

test('diálogos: sólo cuelgan de una ventana que se ve (escondida en la bandeja o minimizada, van sueltos)', () => {
  const v = ventana();
  assert.equal(padreDeDialogo(v), v);
  assert.equal(padreDeDialogo(ventana({ visible: false })), null);
  assert.equal(padreDeDialogo(ventana({ minimizada: true })), null);
  assert.equal(padreDeDialogo(ventana({ destruida: true })), null);
  assert.equal(padreDeDialogo(null), null);
  assert.equal(padreDeDialogo(undefined), null);
  const rota = { isDestroyed: () => { throw new Error('objeto destruido'); }, isVisible: () => true, isMinimized: () => false };
  assert.equal(padreDeDialogo(rota), null, 'un fallo al preguntar no tumba el aviso');
});

test('diálogos: el mismo aviso no se apila y hay un máximo abierto a la vez', () => {
  const f = new FiltroDialogos(2);
  assert.equal(f.abre('a'), true);
  assert.equal(f.abre('a'), false, 'repetido');
  assert.equal(f.abre('b'), true);
  assert.equal(f.abre('c'), false, 'ya hay dos abiertos');
  f.cierra('a');
  assert.equal(f.abre('c'), true);
  assert.equal(f.abre('a'), false, 'tope otra vez');
  assert.equal(f.cuantos, 2);
});

test('ventana caída: recarga las primeras veces, se rinde si se repite en un minuto y vuelve a recargar pasado el tiempo', () => {
  const l = new LimitadorRecargas(3, 60_000);
  assert.equal(l.registra('clean-exit', 0), 'ignora');
  assert.equal(l.registra('crashed', 1000), 'recarga');
  assert.equal(l.registra('crashed', 2000), 'recarga');
  assert.equal(l.registra('oom', 3000), 'recarga');
  assert.equal(l.registra('crashed', 4000), 'rinde');
  assert.equal(l.registra('crashed', 200_000), 'recarga', 'una caída aislada mucho después es otra historia');
});

test('pasos: uno que falla no impide los demás y se cuenta; sin texto no deja línea', async () => {
  const orden: string[] = [];
  const r = await ejecutaPasos([
    { nombre: 'Uno', ejecuta: () => { orden.push('uno'); return 'uno hecho'; } },
    { nombre: 'Dos', ejecuta: () => { throw new Error('se rompió'); } },
    { nombre: 'Tres', ejecuta: async () => { orden.push('tres'); return undefined; } },
    { nombre: 'Cuatro', ejecuta: async () => { throw 'texto suelto'; } },
    { nombre: 'Cinco', ejecuta: async () => { orden.push('cinco'); return 'cinco hecho'; } },
  ]);
  assert.deepEqual(orden, ['uno', 'tres', 'cinco']);
  assert.deepEqual(r.lineas, ['uno hecho', 'Dos FAILED: se rompió', 'Cuatro FAILED: texto suelto', 'cinco hecho']);
  assert.equal(r.fallos, 2);
});

test('conLimite: devuelve true si acaba a tiempo y false (sin colgarse) si no acaba nunca', async () => {
  assert.equal(await conLimite(Promise.resolve(1), 500), true);
  const t0 = Date.now();
  assert.equal(await conLimite(new Promise(() => undefined), 60), false);
  assert.ok(Date.now() - t0 < 1000);
});

/* ── Actualizaciones: nada de diálogos por problemas ajenos al operador ──── */

test('actualizaciones: límites de GitHub y caídas ajenas van en silencio; una versión rara sigue siendo fallo', () => {
  for (const estado of [403, 429, 502, 503, 504]) assert.equal(evalua(estado, null, '0.3.4').tipo, 'silencio', String(estado));
  assert.equal(evalua(500, null, '0.3.4').tipo, 'fallo');
  assert.equal(evalua(200, [{ tag_name: 'rara' }], '0.3.4').tipo, 'fallo');
});

test('actualizaciones: sin red (primer arranque sin internet) se sigue en silencio, sin diálogo', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const v = await compruebaActualizacion('0.3.4');
    assert.equal(v.tipo, 'silencio');
    globalThis.fetch = (() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))) as typeof fetch;
    assert.equal((await compruebaActualizacion('0.3.4')).tipo, 'silencio');
  } finally {
    globalThis.fetch = original;
  }
});

/* ── Servidor local: «Reconnect everything» no se queda esperando ─────────── */

test('servidor local: parar con una conexión persistente abierta (OBS) termina enseguida', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'easyhud-local2-'));
  try {
    writeFileSync(join(raiz, 'index.html'), '<title>x</title>');
    const local = new ServidorLocal({ raiz, puerto: 0, log: () => undefined });
    await local.arranca({ endpoint: 'http://127.0.0.1:1', token: 't', grupo: 'g' });
    const agente = new Agent({ keepAlive: true });
    // Una petición que deja la conexión viva, como el navegador de OBS.
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: local.puerto, path: '/', agent: agente }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });
    const t0 = Date.now();
    await local.para();
    assert.ok(Date.now() - t0 < 2500, `tardó ${Date.now() - t0} ms`);
    assert.equal(local.enMarcha, false);
    agente.destroy();
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
