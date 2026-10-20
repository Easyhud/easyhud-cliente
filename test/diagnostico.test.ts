/**
 * Diagnóstico del programa del jugador: las alertas (qué avisa y cuándo), la sonda de red y el latido
 * de presencia con diagnóstico y acuse.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { Diagnostico, type EstadoRed } from '../src/principal/diagnostico/diagnostico.ts';
import { motivoDeError, sondea, urlSonda } from '../src/principal/diagnostico/sonda.ts';
import { Presencia } from '../src/principal/enlace/presencia.ts';

const cerrar: Array<() => unknown> = [];
after(async () => {
  for (const c of cerrar.reverse()) await c();
});

const redBuena: EstadoRed = { conectada: true, desdeMs: 60_000, conectoAlgunaVez: true, latiendo: true, oidoPorServidor: true, ultimoFallo: '', intentos: 0 };
const ids = (d: Diagnostico, red: EstadoRed) => d.alertas(red).map((a) => a.id);

function reloj() {
  let t = 1_000_000;
  return { ahora: () => t, avanza: (ms: number) => (t += ms) };
}

test('alertas: recién arrancado no grita por lo que se arregla solo', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  d.fijaRiot('x', true);
  r.avanza(5_000);
  assert.deepEqual(ids(d, { ...redBuena, conectada: false, desdeMs: 5_000, latiendo: false, oidoPorServidor: false }), [], 'sin servidor 5 s: aún no');
  assert.deepEqual(ids(d, redBuena), [], 'GEP arrancando 5 s: aún no');
});

test('alertas: servidor inalcanzable, con el motivo, y se quita al volver', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  d.fijaRiot('x', true);
  const caida: EstadoRed = { conectada: false, desdeMs: 30_000, conectoAlgunaVez: true, latiendo: false, oidoPorServidor: false, ultimoFallo: 'no internet', intentos: 7 };
  const [a] = d.alertas(caida);
  assert.equal(a.id, 'servidor');
  assert.equal(a.nivel, 'error');
  assert.match(a.detalle, /no internet/);
  assert.ok(!ids(d, redBuena).includes('servidor'));
  // Al arrancar sin haber conectado nunca (red de Windows aún sin levantar) se espera más antes de alarmar.
  const arrancando: EstadoRed = { ...caida, conectoAlgunaVez: false, desdeMs: 40_000 };
  assert.ok(!ids(d, arrancando).includes('servidor'), 'a los 40 s de arrancar aún no');
  assert.ok(ids(d, { ...arrancando, desdeMs: 95_000 }).includes('servidor'), 'a los 95 s sí');
});

test('alertas: socket abierto pero el servidor no acusa recibo', () => {
  const d = new Diagnostico('0.3.5');
  d.fijaRiot('x', true);
  assert.ok(ids(d, { ...redBuena, oidoPorServidor: false, desdeMs: 50_000 }).includes('servidor-mudo'));
  assert.ok(!ids(d, { ...redBuena, oidoPorServidor: false, desdeMs: 10_000 }).includes('servidor-mudo'), 'con margen');
  // Sin puuid (jugador aún sin cliente de Riot) no hay latido: el silencio no es culpa del servidor.
  assert.ok(!ids(d, { ...redBuena, latiendo: false, oidoPorServidor: false, desdeMs: 120_000 }).includes('servidor-mudo'));
});

test('alertas: GEP caído es error al instante; esperando sólo avisa pasado un minuto', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  d.fijaRiot('x', true);
  d.fijaGep('esperando');
  assert.ok(!ids(d, redBuena).includes('gep-esperando'));
  r.avanza(61_000);
  assert.ok(ids(d, redBuena).includes('gep-esperando'));
  d.fijaGep('caido');
  assert.equal(d.alertas(redBuena)[0].id, 'gep-caido');
  assert.equal(d.alertas(redBuena)[0].nivel, 'error');
  d.fijaGep('listo', '315.0.2');
  assert.deepEqual(ids(d, redBuena), []);
});

test('alertas: VALORANT abierto pero GEP no lo ve (a los 30 s), y sin eventos tras detectarlo (a los 60 s)', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  d.fijaRiot('x', true);
  d.fijaGep('listo');
  d.fijaJuegoAbierto(true);
  r.avanza(20_000);
  assert.ok(!ids(d, redBuena).includes('juego-no-detectado'));
  r.avanza(15_000);
  assert.ok(ids(d, redBuena).includes('juego-no-detectado'));

  d.fijaJuegoDetectado(true);
  assert.ok(!ids(d, redBuena).includes('juego-no-detectado'), 'detectado: ya no');
  r.avanza(61_000);
  assert.ok(ids(d, redBuena).includes('sin-eventos'), 'detectado pero sin un solo evento');
  d.cuentaEvento();
  assert.ok(!ids(d, redBuena).includes('sin-eventos'));
});

test('alertas: sin cliente de Riot a los 90 s, y el error de cámara', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  r.avanza(91_000);
  assert.ok(ids(d, redBuena).includes('riot'));
  d.fijaRiot('signed in', true);
  assert.ok(!ids(d, redBuena).includes('riot'));
  d.fijaCamara({ permitida: true, publicando: false, error: 'no camera found' });
  assert.ok(ids(d, redBuena).includes('camara'));
});

test('alertas: «te creo espectador» sólo cuando está en la partida', () => {
  const d = new Diagnostico('0.3.6');
  d.fijaRiot('x', true);
  d.fijaEspectador(true);
  assert.ok(!ids(d, redBuena).includes('espectador'), 'en el menú no avisa');
  d.fijaDatos('conectada');
  const a = d.alertas(redBuena).find((x) => x.id === 'espectador');
  assert.equal(a?.nivel, 'error');
  d.fijaEspectador(false);
  assert.ok(!ids(d, redBuena).includes('espectador'));
});

test('alertas: los errores van antes que los avisos', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  r.avanza(100_000); // sin Riot: aviso
  d.fijaGep('caido'); // error
  const a = d.alertas(redBuena);
  assert.equal(a[0].nivel, 'error');
  assert.equal(a.at(-1)?.nivel, 'aviso');
});

test('instantánea: contadores, errores (sin repetidos seguidos, con tope) y eventosHace', () => {
  const r = reloj();
  const d = new Diagnostico('0.3.5', r.ahora);
  assert.equal(d.instantanea().eventosHace, null);
  d.cuentaEvento();
  r.avanza(3_000);
  assert.equal(d.instantanea().eventosHace, 3_000);

  d.cuentaEnvio('aux_health');
  d.cuentaEnvio('aux_health');
  d.cuentaEnvio('Tipo Raro!'); // se ignora: el servidor no lo aceptaría
  assert.deepEqual(d.instantanea().enviados, { aux_health: 2 });

  for (let i = 0; i < 10; i++) d.registraError(`fallo ${i}`);
  d.registraError('fallo 9'); // repetido seguido
  const e = d.instantanea().errores;
  assert.equal(e.length, 6);
  assert.equal(e.at(-1), 'fallo 9');
});

test('instantánea: cuenta las claves de GEP (sin el sufijo numérico, en minúsculas) y el flag de espectador', () => {
  const d = new Diagnostico('0.3.6');
  d.cuentaEvento('health');
  d.cuentaEvento('scoreboard_3');
  d.cuentaEvento('scoreboard_7');
  d.cuentaEvento('Raro Nombre!'); // se sanea
  d.fijaEspectador(true);
  const i = d.instantanea();
  assert.deepEqual(i.claves, { health: 1, scoreboard_n: 2, raronombre: 1 });
  assert.equal(i.espectador, true);
});

test('texto del diagnóstico: lleva lo que el operador necesita para ayudar', () => {
  const d = new Diagnostico('0.3.5');
  d.fijaGep('listo', '315.0.2');
  d.fijaJuegoAbierto(true);
  d.cuentaEnvio('aux_health');
  d.registraError('algo falló');
  const t = d.texto({ ...redBuena, conectada: false, desdeMs: 30_000, oidoPorServidor: false, ultimoFallo: 'timeout', intentos: 4 });
  for (const trozo of ['Easy HUD 0.3.5', 'NOT connected', 'timeout', 'Overwolf GEP: listo 315.0.2', 'VALORANT: open', 'aux_health=1', 'algo falló', 'Problems:']) {
    assert.ok(t.includes(trozo), `falta «${trozo}»`);
  }
});

test('sonda: la URL sale del puerto de ingesta + 1, y los errores de red se explican', () => {
  assert.equal(urlSonda('http://2.24.200.205:5100'), 'http://2.24.200.205:5101/status');
  assert.equal(urlSonda('https://easy.example:5100/'), 'https://easy.example:5101/status');
  assert.equal(urlSonda('easy.example'), 'https://easy.example:5101/status');
  assert.equal(urlSonda('http://x:abc'), null);
  assert.match(motivoDeError({ code: 'ENOTFOUND' }), /no internet/);
  assert.match(motivoDeError({ code: 'ECONNREFUSED' }), /refused/);
  assert.match(motivoDeError({ code: 'ETIMEDOUT' }), /firewall/);
});

test('sonda: servidor vivo → ok; puerto muerto → motivo legible; tarda demasiado → timeout', async () => {
  const vivo = createServer((_req, res) => res.end('{"status":"UP"}'));
  await new Promise<void>((r) => vivo.listen(0, '127.0.0.1', () => r()));
  cerrar.push(() => new Promise((r) => vivo.close(r)));
  const puerto = (vivo.address() as { port: number }).port;
  assert.deepEqual(await sondea(`http://127.0.0.1:${puerto}/status`), { ok: true, motivo: '' });

  const muerto = await sondea('http://127.0.0.1:1/status');
  assert.equal(muerto.ok, false);
  assert.match(muerto.motivo, /refused|network error/);

  const lento = createServer(() => undefined); // acepta y no contesta
  await new Promise<void>((r) => lento.listen(0, '127.0.0.1', () => r()));
  cerrar.push(() => new Promise((r) => { lento.closeAllConnections(); lento.close(r); }));
  const r = await sondea(`http://127.0.0.1:${(lento.address() as { port: number }).port}/status`, 300);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /did not answer in time/);
});

test('presencia: el latido lleva el diagnóstico, pide acuse y estadoRed lo refleja', async () => {
  const http = createServer();
  const io = new Server(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  cerrar.push(() => new Promise((r) => io.close(() => r(undefined))));
  const puerto = (http.address() as { port: number }).port;

  const recibido: Array<{ puuid: string; estado?: { version: string } }> = [];
  io.on('connection', (s) =>
    s.on('cliente_presente', (msg: string, ack?: (r: unknown) => void) => {
      recibido.push(JSON.parse(msg));
      ack?.({ ok: true });
    }),
  );

  const d = new Diagnostico('0.3.5');
  const p = new Presencia({
    url: `http://127.0.0.1:${puerto}`,
    puuid: () => 'puuid-diag',
    alLlamar: () => undefined,
    log: () => undefined,
    periodoMs: 60_000,
    diagnostico: () => d.instantanea(),
  });
  p.arranca();
  cerrar.push(() => p.para());
  for (let i = 0; i < 100 && !(p.estadoRed().oidoPorServidor); i++) await new Promise((r) => setTimeout(r, 50));

  assert.equal(recibido[0].puuid, 'puuid-diag');
  assert.equal(recibido[0].estado?.version, '0.3.5');
  const red = p.estadoRed();
  assert.equal(red.conectada, true);
  assert.equal(red.latiendo, true);
  assert.equal(red.oidoPorServidor, true, 'el acuse del servidor llegó');
});

test('presencia: si el servidor acusaba y deja de hacerlo, se fuerza la reconexión', async () => {
  const http = createServer();
  const io = new Server(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  cerrar.push(() => new Promise((r) => io.close(() => r(undefined))));
  const puerto = (http.address() as { port: number }).port;

  let conexiones = 0;
  let acusa = true;
  io.on('connection', (s) => {
    conexiones += 1;
    s.on('cliente_presente', (_m: string, ack?: (r: unknown) => void) => {
      if (acusa) ack?.({ ok: true });
    });
  });

  const logs: string[] = [];
  const p = new Presencia({
    url: `http://127.0.0.1:${puerto}`,
    puuid: () => 'puuid-mudo',
    alLlamar: () => undefined,
    log: (t) => logs.push(t),
    periodoMs: 60_000,
    acuseMaxMs: 300,
  });
  p.arranca();
  cerrar.push(() => p.para());
  const espera = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(cond(), 'no llegó a tiempo');
  };
  await espera(() => p.estadoRed().oidoPorServidor);

  acusa = false; // el servidor sigue conectado pero ya no contesta
  await new Promise((r) => setTimeout(r, 400));
  p.late(); // el siguiente latido ve que lleva más de acuseMaxMs sin acuse
  await espera(() => conexiones >= 2);
  assert.ok(logs.some((l) => /dejó de acusar recibo/.test(l)));
});

test('presencia: un servidor antiguo que nunca acusa NO provoca reconexiones', async () => {
  const http = createServer();
  const io = new Server(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  cerrar.push(() => new Promise((r) => io.close(() => r(undefined))));
  const puerto = (http.address() as { port: number }).port;
  let conexiones = 0;
  io.on('connection', (s) => {
    conexiones += 1;
    s.on('cliente_presente', () => undefined); // no llama al acuse
  });
  const p = new Presencia({
    url: `http://127.0.0.1:${puerto}`,
    puuid: () => 'puuid-viejo',
    alLlamar: () => undefined,
    log: () => undefined,
    periodoMs: 60_000,
    acuseMaxMs: 100,
  });
  p.arranca();
  cerrar.push(() => p.para());
  await new Promise((r) => setTimeout(r, 400));
  p.late();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(conexiones, 1);
  assert.equal(p.estadoRed().conectada, true);
  assert.equal(p.estadoRed().oidoPorServidor, false);
});

test('conflictos: se detectan otros programas que usan Overwolf, sin contarse a sí mismo ni a su lanzador ni a sus hijos', async () => {
  const { buscaConflictos } = await import('../src/principal/sistema/conflictos.ts');
  const p = (pid: number, padre: number, ruta: string, orden = '') => ({ pid, padre, ruta, orden: orden || ruta });
  const lista = [
    p(100, 1, 'C:/Users/a/Downloads/EasyHUD-Player.exe'), // el lanzador portable (padre de nosotros)
    p(200, 100, 'C:/Temp/Easy HUD/EasyHUD.exe'), // YO
    p(201, 200, 'C:/Temp/Easy HUD/EasyHUD.exe', 'EasyHUD.exe --type=renderer'), // mi hijo
    p(300, 1, 'C:/Users/a/AppData/Local/Programs/ValoSpectra/ValoSpectra.exe'), // otro programa: conflicto
    p(301, 300, 'C:/Users/a/AppData/Local/Programs/ValoSpectra/ValoSpectra.exe', 'ValoSpectra.exe --type=gpu-process'), // su hijo: no cuenta
    p(400, 1, 'C:/Program Files/Overwolf/Overwolf.exe'), // Overwolf de escritorio: conflicto
    p(500, 1, 'C:/Windows/explorer.exe'),
    p(501, 1, 'C:/Program Files/Valorant/VALORANT.exe'),
  ];
  assert.deepEqual(buscaConflictos(lista, 200), ['ValoSpectra.exe (pid 300)', 'Overwolf.exe (pid 400)']);
  assert.deepEqual(buscaConflictos(lista.slice(0, 3).concat(lista.slice(6)), 200), [], 'sin competidores no hay nada');
});

test('conflictos: viajan en el diagnóstico y dan una alerta con los nombres', () => {
  const d = new Diagnostico('0.3.7');
  d.fijaRiot('x', true);
  assert.deepEqual(d.instantanea().conflictos, []);
  d.fijaConflictos(['ValoSpectra.exe (pid 300)']);
  assert.deepEqual(d.instantanea().conflictos, ['ValoSpectra.exe (pid 300)']);
  const a = d.alertas(redBuena).find((x) => x.id === 'conflicto');
  assert.equal(a?.nivel, 'error');
  assert.match(a?.detalle ?? '', /ValoSpectra\.exe/);
  assert.match(d.texto(redBuena), /CONFLICT/);
  d.fijaConflictos([]);
  assert.ok(!ids(d, redBuena).includes('conflicto'));
});
