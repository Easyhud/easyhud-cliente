/**
 * Piezas pequeñas y puras: teclas, sala de Riot, actualizaciones, estado de
 * eventos, Overwolf nativo, rutas estáticas, contexto de Riot, montaje del
 * overlay y guarda de identidad.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planAtajos, teclaValida } from '../src/principal/atajos.ts';
import { resuelveRuta, tipoDe } from '../src/principal/local/estaticos.ts';
import { leeLockfile, servidoresDelLog } from '../src/principal/riot/contexto.ts';
import { ciudadServidor, construyeSala, nombreMapa, nombreModo, puuidsDeSala } from '../src/principal/riot/sala.ts';
import { evalua } from '../src/principal/sistema/actualizaciones.ts';
import { estadoDeEventos } from '../src/principal/sistema/estado-eventos.ts';
import { pidsDeTasklist } from '../src/principal/sistema/overwolf-nativo.ts';

const carpetas: string[] = [];
after(() => {
  for (const c of carpetas) rmSync(c, { recursive: true, force: true });
});

test('teclas: patrón F1–F24 con modificadores', () => {
  for (const t of ['F1', 'F9', 'F10', 'F12', 'F19', 'F24', 'Ctrl+Alt+K', 'Shift+5', 'A', 'Ctrl+Shift+F11']) assert.equal(teclaValida(t), true, t);
  for (const t of ['F25', 'F30', 'F0', 'AB', 'Ctrl+', '', 'Ctrl+AB', 'Win+A']) assert.equal(teclaValida(t), false, t);
});

test('teclas: plan de registro; una inválida no tumba las demás; showToast no se registra', () => {
  assert.equal(planAtajos(null), null);
  assert.equal(planAtajos({ spikePlanted: 'F1' }), null);
  const plan = planAtajos({
    spikePlanted: 'F1',
    techPause: 'XX',
    leftTimeout: 'F3',
    rightTimeout: 'F4',
    switchKdaCredits: 'F5',
    showToast: 'F6',
    enabled: { spikePlanted: true, techPause: true, leftTimeout: true, rightTimeout: false, switchKdaCredits: true, showToast: true },
  });
  assert.deepEqual(plan, {
    registros: [
      { mando: 'spikePlanted', tecla: 'F1', type: 'spike_planted' },
      { mando: 'leftTimeout', tecla: 'F3', type: 'left_timeout' },
      { mando: 'switchKdaCredits', tecla: 'F5', type: 'switch_kda_credits' },
    ],
    invalidas: ['XX'],
  });
});

test('sala: mapas, modos y ciudades', () => {
  assert.equal(nombreMapa('/Game/Maps/Duality/Duality'), 'Bind');
  assert.equal(nombreMapa('/Game/Maps/Infinity/Infinity'), 'Abyss');
  assert.equal(nombreMapa('/Game/Maps/Nuevo/Nuevo'), 'Nuevo');
  assert.equal(nombreModo('/Game/GameModes/Bomb/BombGameMode.BombGameMode_C'), 'Estándar');
  assert.equal(nombreModo('/Game/GameModes/Deathmatch/DeathmatchGameMode.X'), 'Deathmatch');
  assert.equal(nombreModo(''), '');
  assert.equal(ciudadServidor('aresriot.aws-scl1-prod.latam-gp-santiago-1'), 'Santiago');
  assert.equal(ciudadServidor('aresriot.aws-gru1-prod.latam-gp-saopaulo-1'), 'São Paulo');
  assert.equal(ciudadServidor('aresriot.x.eu-gp-frankfurt-1'), 'Frankfurt');
});

test('sala: forma del objeto que ven el panel y el servidor', () => {
  const party = {
    State: 'CUSTOM_GAME_SETUP',
    InviteCode: 'ABC123',
    Accessibility: 'CLOSED',
    Members: [{ Subject: 'p1', IsReady: true, IsModerator: true, UseBroadcastHUD: false }, { Subject: 'p2' }],
    CustomGameData: {
      Settings: { Map: '/Game/Maps/Ascent/Ascent', Mode: '/Game/GameModes/Bomb/BombGameMode.BombGameMode_C', GamePod: 'x-gp-bogota-1' },
      Membership: {
        teamOne: [{ Subject: 'p1' }],
        teamTwo: [{ Subject: 'p2' }],
        teamSpectate: [{ Subject: 'obs' }],
        teamOneCoaches: [{ Subject: 'c1' }],
        teamTwoCoaches: null,
      },
    },
  };
  assert.deepEqual(puuidsDeSala(party), ['p1', 'p2', 'obs', 'c1']);
  const sala = construyeSala(party, new Map([['p1', { nombre: 'Uno', tag: 'T1' }]]), (p) => (p === 'p1' ? 20 : undefined));
  assert.ok(sala);
  assert.deepEqual(sala.equipoUno, [{ puuid: 'p1', nombre: 'Uno', tag: 'T1', rango: 20, listo: true, moderador: true, hudBroadcast: false }]);
  assert.deepEqual(sala.equipoDos, [{ puuid: 'p2', nombre: '…', tag: '', listo: false, moderador: false, hudBroadcast: false }]);
  assert.equal(sala.coaches.length, 1);
  assert.deepEqual(sala.coachesDos, []);
  assert.equal(sala.codigo, 'ABC123');
  assert.equal(sala.mapa, 'Ascent');
  assert.equal(sala.modo, 'Estándar');
  assert.equal(sala.servidor, 'Bogotá');
  assert.equal(sala.cerrada, true);
  assert.equal(sala.estado, 'CUSTOM_GAME_SETUP');
  assert.equal(construyeSala({ CustomGameData: {} }, new Map(), () => undefined), null);
});

test('contexto de Riot: lockfile y servidores del log', () => {
  assert.deepEqual(leeLockfile('Riot Client:1234:54321:clave:https'), { puerto: '54321', clave: 'clave', protocolo: 'https' });
  assert.equal(leeLockfile('corto:1'), null);
  const log = 'x https://pd.eu.a.pvp.net/foo y https://glz-eu-1.eu.a.pvp.net/parties z';
  assert.deepEqual(servidoresDelLog(log), { glz: 'https://glz-eu-1.eu.a.pvp.net', pd: 'https://pd.eu.a.pvp.net', region: 'eu' });
  assert.deepEqual(servidoresDelLog(''), { glz: '', pd: '', region: '' });
});

test('actualizaciones: 404 en silencio, nueva, al día, fallo', () => {
  assert.equal(evalua(404, null, '0.3.4').tipo, 'silencio');
  assert.deepEqual(evalua(200, [{ tag_name: 'v0.3.9', name: 'Easy HUD 0.3.9' }], '0.3.4'), { tipo: 'nueva', version: '0.3.9', nombre: 'Easy HUD 0.3.9' });
  assert.equal(evalua(200, [{ tag_name: 'v0.3.4' }], '0.3.4').tipo, 'al-dia');
  assert.equal(evalua(200, [{ tag_name: '0.3.1' }], '0.3.4').tipo, 'al-dia');
  assert.equal(evalua(200, [{ tag_name: 'ultima' }], '0.3.4').tipo, 'fallo');
  assert.equal(evalua(500, null, '0.3.4').tipo, 'fallo');
  assert.equal(evalua(200, [], '0.3.4').tipo, 'silencio');
});

test('estado de eventos de Overwolf', () => {
  assert.equal(estadoDeEventos({ state: 1 }, false), null);
  assert.equal(estadoDeEventos({ state: 2, disabled: true }, false), 4);
  const cuerpo = { state: 2, features: [{ name: 'match_info', state: 2 }, { name: 'me', state: 3 }] };
  assert.equal(estadoDeEventos(cuerpo, false), 2);
  assert.equal(estadoDeEventos(cuerpo, true), 3);
});

test('Overwolf nativo: PIDs de tasklist', () => {
  const salida = '"Overwolf.exe","4321","Console","1","120,000 K"\r\n"overwolf.exe","99","Console","1","1 K"\r\n"Otro.exe","5","x","1","1 K"';
  assert.deepEqual(pidsDeTasklist(salida), [4321, 99]);
  assert.deepEqual(pidsDeTasklist('INFO: No tasks are running which match the specified criteria.'), []);
});

test('estáticos: index.html, fuera de la raíz, tipos', () => {
  const raiz = resolve('/srv/overlay');
  assert.equal(resuelveRuta(raiz, '/'), join(raiz, 'index.html'));
  assert.equal(resuelveRuta(raiz, '/operador/?x=1'), join(raiz, 'operador', 'index.html'));
  assert.equal(resuelveRuta(raiz, '/comun/fuente.js'), join(raiz, 'comun', 'fuente.js'));
  assert.equal(resuelveRuta(raiz, '/../secreto.txt'), null);
  assert.equal(resuelveRuta(raiz, '/%2e%2e/%2e%2e/secreto.txt'), null);
  assert.equal(resuelveRuta(raiz, '/%E0%A4%A'), null);
  assert.equal(tipoDe('a.html'), 'text/html; charset=utf-8');
  assert.equal(tipoDe('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(tipoDe('a.woff2'), 'font/woff2');
  assert.equal(tipoDe('a.ICO'), 'image/x-icon');
  assert.equal(tipoDe('a.bin'), 'application/octet-stream');
});

test('montaje: la verificación encuentra referencias rotas (estáticas, dinámicas, sin from, CSS, HTML)', async () => {
  // @ts-expect-error: módulo .mjs sin tipos
  const { verificaReferencias } = await import('../scripts/monta-overlay.mjs');
  const raiz = mkdtempSync(join(tmpdir(), 'easyhud-monta-'));
  carpetas.push(raiz);
  mkdirSync(join(raiz, 'js'));
  writeFileSync(join(raiz, 'js', 'bien.js'), "export const x = 1;\n");
  writeFileSync(
    join(raiz, 'js', 'a.js'),
    [
      "import { x } from './bien.js';",
      "import './falta-lateral.js';",
      "const m = await import('./falta-dinamica.js');",
      "export { y } from './falta-reexport.js';",
      "import io from 'socket.io-client';",
      "// import './comentado.js';",
      "fetch('https://valorant-api.com/x');",
    ].join('\n'),
  );
  writeFileSync(join(raiz, 'a.css'), "@import './falta.css'; .x { background: url('img/falta.png') } .y { background: url(data:image/png;base64,AA) }");
  writeFileSync(join(raiz, 'index.html'), '<link href="a.css"><script type="module">import "./js/falta-en-linea.js";</script><img src="https://x/y.png"><a href="#arriba">');
  const rotas = verificaReferencias(raiz) as string[];
  const texto = rotas.join('\n');
  for (const esperada of ['falta-lateral.js', 'falta-dinamica.js', 'falta-reexport.js', 'socket.io-client', 'falta.css', 'img/falta.png', 'falta-en-linea.js']) {
    assert.ok(texto.includes(esperada), `debió detectar ${esperada}\n${texto}`);
  }
  assert.ok(!texto.includes('bien.js'));
  assert.ok(!texto.includes('comentado.js'));
  assert.ok(!texto.includes('valorant-api'));
  assert.equal(rotas.length, 7);
});

test('guarda de identidad: pasa con lo aprobado y falla si se toca un campo', async () => {
  // @ts-expect-error: módulo .mjs sin tipos
  const { compruebaIdentidad } = await import('../scripts/comprueba-identidad.mjs');
  assert.deepEqual(compruebaIdentidad(), []);

  // Se toca una COPIA del proyecto (identidad, package.json y configuraciones del builder).
  const copia = mkdtempSync(join(tmpdir(), 'easyhud-identidad-'));
  carpetas.push(copia);
  const proyecto = new URL('..', import.meta.url);
  mkdirSync(join(copia, 'build'));
  for (const f of ['identidad.json', 'package.json', 'build/builder.base.cjs', 'build/builder.normal.cjs', 'build/builder.observer.cjs', 'build/builder.player.cjs']) {
    writeFileSync(join(copia, f), readFileSync(new URL(f, proyecto)));
  }
  const identidad = JSON.parse(readFileSync(join(copia, 'identidad.json'), 'utf8'));
  assert.deepEqual(compruebaIdentidad(copia), []);

  writeFileSync(join(copia, 'identidad.json'), JSON.stringify({ ...identidad, author: { ...identidad.author, name: 'Easy HUD' } }));
  assert.ok((compruebaIdentidad(copia) as string[]).some((f) => f.includes('identidad.json → author.name')));

  // El productName de las tres configuraciones del builder sale de identidad.json.
  writeFileSync(join(copia, 'identidad.json'), JSON.stringify({ ...identidad, productName: 'Easy HUD' }));
  const porProducto = compruebaIdentidad(copia) as string[];
  for (const p of ['normal', 'observer', 'player']) assert.ok(porProducto.some((f) => f.includes(`builder.${p}.cjs → productName`)), p);

  writeFileSync(join(copia, 'identidad.json'), JSON.stringify(identidad));
  const paquete = JSON.parse(readFileSync(join(copia, 'package.json'), 'utf8'));
  writeFileSync(join(copia, 'package.json'), JSON.stringify({ ...paquete, name: 'easyhud-client' }));
  assert.ok((compruebaIdentidad(copia) as string[]).some((f) => f.includes('package.json → name')));

  writeFileSync(join(copia, 'package.json'), JSON.stringify(paquete));
  writeFileSync(join(copia, 'build', 'builder.player.cjs'), `module.exports = { ...require('./builder.base.cjs'), appId: 'net.easyhud.player' };`);
  assert.ok((compruebaIdentidad(copia) as string[]).some((f) => f.includes('builder.player.cjs → appId')));
});
