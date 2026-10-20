/**
 * La caja negra: la grabadora de GEP, el entorno del PC y las conclusiones automáticas del informe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostico, type EstadoRed } from '../src/principal/diagnostico/diagnostico.ts';
import { GrabadoraGep } from '../src/principal/diagnostico/grabadora-gep.ts';
import { armaInforme, conclusiones, type EntradaInforme } from '../src/principal/diagnostico/informe.ts';
import { leeEntorno } from '../src/principal/sistema/entorno.ts';

const red: EstadoRed = { conectada: true, desdeMs: 60_000, conectoAlgunaVez: true, latiendo: true, oidoPorServidor: true, ultimoFallo: '', intentos: 0 };

/** Un informe base «sano» sobre el que cada prueba cambia lo suyo. */
function base(cambios: Partial<EntradaInforme> = {}, preparaGrabacion?: (g: GrabadoraGep) => void, preparaDiag?: (d: Diagnostico) => void): EntradaInforme {
  const d = new Diagnostico('0.3.10');
  d.fijaGep('listo', '315.0.2');
  d.fijaJuegoAbierto(true);
  d.fijaJuegoDetectado(true);
  d.fijaDatos('conectada');
  d.fijaRiot('signed in as X#T', true);
  preparaDiag?.(d);
  const g = new GrabadoraGep();
  preparaGrabacion?.(g);
  return {
    creado: 1_000,
    version: '0.3.10',
    perfil: 'player',
    jugador: 'X#T',
    diag: d.instantanea(),
    red,
    alertas: [],
    autoprueba: null,
    gep: { version: '315.0.2', features: ['match_info', 'me', 'game_info'], featuresError: '', infoClaves: [], infoError: '' },
    grabacion: g.instantanea(),
    entorno: { so: 'Windows', arquitectura: 'x64', esAdmin: false, valorantElevado: false, antivirus: [], overwolfInstalado: [], overwolfAbierto: 0, ejecutable: 'C:/x/EasyHUD.exe', desdeTemporal: false },
    conflictos: [],
    log: [],
    ...cambios,
  };
}

const ids = (e: EntradaInforme) => conclusiones(e).map((c) => c.id);
const enPartida = (g: GrabadoraGep) => {
  g.registra('info', 'scene', 'Ascent');
  g.registra('info', 'kills', '1');
  g.registra('info', 'roster_3', '{}');
};

test('grabadora: cuenta por clave (sin el sufijo numérico), recuerda de dónde llegó y limita el anillo', () => {
  let t = 100;
  const g = new GrabadoraGep(3, () => (t += 10));
  g.registra('info', 'scoreboard_1', '{"a":1}');
  g.registra('info', 'scoreboard_7', '{"a":2}');
  g.registra('sondeo', 'health', 100);
  g.registra('evento', 'kill', 'x'.repeat(500));
  g.suceso('game-detected', 'VALORANT');
  const s = g.instantanea();
  assert.equal(s.total, 4);
  assert.equal(s.porClave.scoreboard_N.n, 2);
  assert.deepEqual(s.porClave.scoreboard_N.via, ['info']);
  assert.deepEqual(s.porClave.health.via, ['sondeo']);
  assert.ok(s.porClave.kill.muestra.length <= 161, 'el valor se recorta');
  assert.equal(s.ultimos.length, 3, 'el anillo no pasa del máximo');
  assert.equal(s.sucesos[0].key, 'game-detected');
  assert.ok(s.porClave.scoreboard_N.ultimo > s.porClave.scoreboard_N.primero);
});

test('entorno: lee la salida de PowerShell y tolera que falte o venga rota', () => {
  const e = leeEntorno('{"admin":false,"valorantElevado":true,"antivirus":["Windows Defender"],"overwolf":"C:\\\\Overwolf","overwolfAbierto":2}', 'C:/Users/a/AppData/Local/Temp/EasyHUD-Player/EasyHUD.exe');
  assert.equal(e.esAdmin, false);
  assert.equal(e.valorantElevado, true);
  assert.deepEqual(e.antivirus, ['Windows Defender']);
  assert.equal(e.overwolfInstalado.length, 1);
  assert.equal(e.overwolfAbierto, 2);
  assert.equal(e.desdeTemporal, true);
  const roto = leeEntorno('esto no es json', 'C:/Program Files/EasyHUD/EasyHUD.exe');
  assert.equal(roto.esAdmin, null);
  assert.equal(roto.desdeTemporal, false);
});

test('conclusión: sin problemas, con una partida sana, lo dice', () => {
  const e = base({}, (g) => {
    enPartida(g);
    g.registra('info', 'health', '100');
    g.registra('info', 'abilities', '{}');
  });
  assert.deepEqual(ids(e), ['sin-problemas']);
});

test('conclusión: sin VALORANT abierto no se dice «todo bien»: se dice que no se puede juzgar', () => {
  const e = base({}, undefined, (d) => {
    d.fijaJuegoAbierto(false);
    d.fijaJuegoDetectado(false);
    d.fijaDatos('cerrada');
  });
  assert.deepEqual(ids(e), ['sin-juego']);
});

test('conclusión: ve eventos pero NO recibe vida ni habilidades, y Overwolf no las tiene en su estado → «overwolf-no-entrega»', () => {
  const e = base({}, enPartida);
  const c = conclusiones(e).find((x) => x.id === 'overwolf-no-entrega');
  assert.equal(c?.certeza, 'confirmada');
  assert.match(c?.texto ?? '', /NO genera health ni abilities/);
});

test('conclusión: Overwolf TIENE la vida pero no la avisa → «avisos-perdidos» (y el sondeo la recogió)', () => {
  const e = base({}, (g) => {
    enPartida(g);
    g.registra('sondeo', 'health', '88');
    g.registra('sondeo', 'abilities', '{}');
  });
  assert.equal(conclusiones(e).find((x) => x.id === 'avisos-perdidos')?.certeza, 'confirmada');
  assert.ok(!ids(e).includes('overwolf-no-entrega'));
});

test('conclusión: el juego corre como administrador → «elevado» (confirmada por el suceso, probable por el entorno)', () => {
  const porSuceso = base({}, (g) => g.suceso('elevated-privileges-required', '21640'));
  assert.equal(conclusiones(porSuceso).find((x) => x.id === 'elevado')?.certeza, 'confirmada');
  const porEntorno = base({ entorno: { ...base().entorno!, valorantElevado: true, esAdmin: false } });
  assert.equal(conclusiones(porEntorno).find((x) => x.id === 'elevado')?.certeza, 'probable');
  const mismosPermisos = base({ entorno: { ...base().entorno!, valorantElevado: true, esAdmin: true } });
  assert.ok(!ids(mismosPermisos).includes('elevado'));
});

test('conclusión: otro programa usa Overwolf, el Overwolf de escritorio abierto, el espectador y GEP caído', () => {
  assert.ok(ids(base({ conflictos: ['ValoSpectra.exe (pid 3)'] })).includes('conflicto'));
  assert.ok(ids(base({ entorno: { ...base().entorno!, overwolfAbierto: 1 } })).includes('overwolf-escritorio'));
  const esp = base({}, enPartida, (d) => d.fijaEspectador(true));
  assert.ok(ids(esp).includes('espectador'));
  assert.ok(!ids(esp).includes('overwolf-no-entrega'), 'si es espectador no se culpa a Overwolf');
  const caido = base({}, undefined, (d) => d.fijaGep('caido'));
  assert.ok(ids(caido).includes('gep-caido'));
});

test('conclusión: la feature «me» no existe en esta versión de GEP → «sin-feature-me»', () => {
  const e = base({ gep: { version: '1.0', features: ['match_info', 'game_info'], featuresError: '', infoClaves: null, infoError: 'x' } }, enPartida);
  assert.equal(conclusiones(e).find((x) => x.id === 'sin-feature-me')?.certeza, 'confirmada');
});

test('conclusión: GEP listo y ve el juego pero no entregó nada, y VALORANT abierto sin detectar', () => {
  assert.ok(ids(base()).includes('sin-nada'));
  const noDetecta = base({}, undefined, (d) => d.fijaJuegoDetectado(false));
  assert.ok(ids(noDetecta).includes('no-detecta'));
});

test('conclusión: sin partida todavía → pide repetir el informe durante una; con GEP sin consultar → «probable»', () => {
  const sinPartida = base({}, (g) => g.registra('info', 'scene', 'MainMenu'));
  assert.ok(ids(sinPartida).includes('sin-partida'));
  const sinConsulta = base({ gep: { version: '', features: null, featuresError: 'no listo', infoClaves: null, infoError: 'no listo' } }, enPartida);
  assert.equal(conclusiones(sinConsulta).find((x) => x.id === 'faltan-datos')?.certeza, 'probable');
});

test('armaInforme: el documento lleva las conclusiones y todo lo recogido, y es JSON serializable', () => {
  const doc = armaInforme(base({ log: ['línea 1'] }, enPartida));
  assert.equal(doc.formato, 1);
  assert.ok(doc.conclusiones.length > 0);
  assert.equal(doc.jugador, 'X#T');
  assert.deepEqual(doc.gep.claveSinAvisos, ['health', 'abilities']);
  const ida = JSON.parse(JSON.stringify(doc));
  assert.equal(ida.programa.version, '0.3.10');
  assert.ok(Object.hasOwn(ida.grabacion.porClave, 'kills'));
});
