/**
 * Cargas de logon, traducción de rechazos, direcciones y perfiles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logonJugador, logonObservador, motivoAmable, nombreDelToken, toolsDataInicial } from '../src/principal/enlace/mensajes.ts';
import { cargaPerfil, perfilPara, rolEfectivo } from '../src/principal/perfil.ts';
import { derivaSalida, normalizaIngesta } from '../src/principal/urls.ts';

const token = (cuerpo: unknown) => `${Buffer.from(JSON.stringify(cuerpo)).toString('base64url')}.firma`;

test('obs_logon: forma exacta', () => {
  const t = token({ g: 'abc', exp: 1, c: 'Liga Norte' });
  assert.deepEqual(logonObservador({ version: '0.3.4', token: t, grupo: 'abc', secreto: 'S3CR3T' }), {
    type: 'authenticate',
    clientVersion: '0.3.4',
    obsName: 'Liga Norte',
    key: t,
    groupCode: 'ABC',
    groupSecret: 'S3CR3T',
    leftTeam: { name: '', tricode: '', url: '', attackStart: true },
    rightTeam: { name: '', tricode: '', url: '', attackStart: false },
    toolsData: toolsDataInicial(),
  });
  assert.deepEqual(toolsDataInicial().timeoutCounter, { max: 2, left: 2, right: 2 });
  assert.deepEqual(toolsDataInicial().roundWinBox, { type: 'disabled', sponsors: [] });
});

test('obsName: "Observer" si el token no se puede leer', () => {
  assert.equal(nombreDelToken('basura'), 'Observer');
  assert.equal(nombreDelToken(token({ c: '' })), 'Observer');
  assert.equal(nombreDelToken(token({ g: 'x' })), 'Observer');
  assert.equal(nombreDelToken('%%%.x'), 'Observer');
});

test('aux_logon por matchId y por grupo', () => {
  assert.deepEqual(logonJugador({ version: '0.3.4', nombre: 'Yo', puuid: 'p', matchId: 'm' }), {
    type: 'aux_authenticate',
    clientVersion: '0.3.4',
    name: 'Yo',
    matchId: 'm',
    playerId: 'p',
  });
  assert.deepEqual(logonJugador({ version: '0.3.4', nombre: 'Yo', puuid: 'p', grupo: 'G' }), {
    type: 'aux_authenticate',
    clientVersion: '0.3.4',
    name: 'Yo',
    matchId: '',
    groupCode: 'G',
    playerId: 'p',
  });
});

test('tabla F: motivos del servidor v2', () => {
  assert.match(motivoAmable('Game with Group Code ABC exists and is still live.'), /already a live broadcast/);
  assert.match(motivoAmable('Client version 0.2.0 is not compatible with server version 2.0.0.'), /out of date/);
  assert.match(motivoAmable('Game with Match ID x not found.'), /no longer live/);
  assert.match(motivoAmable('Expired Key'), /expired/);
  assert.match(motivoAmable('Invalid Key'), /didn't accept/);
  assert.equal(motivoAmable('otra cosa'), 'otra cosa');
  assert.equal(motivoAmable(''), 'Connection failed.');
  assert.equal(motivoAmable(undefined), 'Connection failed.');
});

test('URL de ingesta: normalización y salida derivada', () => {
  assert.equal(normalizaIngesta('http://2.24.200.205:5100'), 'http://2.24.200.205:5100');
  assert.equal(normalizaIngesta('https://ingesta.easyhud.net:443/x'), 'https://ingesta.easyhud.net:443/x');
  assert.equal(normalizaIngesta('ingesta.easyhud.net:5100'), 'https://ingesta.easyhud.net:5100');
  assert.equal(normalizaIngesta('ingesta.easyhud.net'), 'https://ingesta.easyhud.net:5100');
  assert.equal(normalizaIngesta('http://ingesta.easyhud.net'), 'http://ingesta.easyhud.net:5100');
  assert.equal(derivaSalida('http://2.24.200.205:5100'), 'http://2.24.200.205:5200');
  assert.equal(derivaSalida('http://h:5100/ruta'), 'http://h:5200/ruta');
  assert.equal(derivaSalida('http://h:51000'), 'http://h:51000');
});

test('perfiles: valores exactos y rol efectivo', () => {
  assert.deepEqual(perfilPara('normal', 'ignorada'), {
    mode: 'normal',
    ingestIp: null,
    lockConnection: false,
    forceAutostart: false,
    forceTray: false,
    startHidden: false,
  });
  assert.deepEqual(perfilPara('observer', 'http://2.24.200.205:5100'), {
    mode: 'observer',
    ingestIp: 'http://2.24.200.205:5100',
    lockConnection: true,
    forceAutostart: false,
    forceTray: true,
    startHidden: false,
  });
  assert.deepEqual(perfilPara('player', 'http://2.24.200.205:5100'), {
    mode: 'player',
    ingestIp: 'http://2.24.200.205:5100',
    lockConnection: true,
    forceAutostart: true,
    forceTray: true,
    startHidden: true,
  });
  assert.equal(rolEfectivo(perfilPara('normal'), ['x', '--auxiliary']), 'jugador');
  assert.equal(rolEfectivo(perfilPara('normal'), ['x']), 'observador');
  assert.equal(rolEfectivo(perfilPara('player', 'u'), ['x']), 'jugador');
  assert.equal(rolEfectivo(perfilPara('observer', 'u'), ['x', '--auxiliary']), 'observador');
  // Sin perfil quemado (desarrollo): normal.
  assert.equal(cargaPerfil(new URL('file:///no/existe/perfil.json')).mode, 'normal');
});
