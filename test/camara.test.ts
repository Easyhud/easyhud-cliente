/**
 * La cámara del jugador: ID del stream, validación de lo que manda el
 * servidor y dirección de publicación. Todo puro.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debePublicar, idDeCamara, leeConfigCamara, urlPublicacion } from '../src/principal/camara/url.ts';

const config = {
  enable: true,
  room: 'SALA9',
  base: 'https://cam.easyhud.net',
  params: 'wss2=cam.easyhud.net/wss',
  clave: 'abc-DEF_123',
};

test('ID de cámara: Nombre_H_TAG, lo no alfanumérico a «_»', () => {
  assert.equal(idDeCamara('JugadorUno#EUW'), 'JugadorUno_H_EUW');
  assert.equal(idDeCamara('Nick Name#1234'), 'Nick_Name_H_1234');
  assert.equal(idDeCamara('Ñu  Ñu#ES1'), '_u_u_H_ES1', 'rachas y acentos como la web de vídeo');
  assert.equal(idDeCamara('SinTag'), null);
  assert.equal(idDeCamara('#EUW'), null);
  assert.equal(idDeCamara('Nombre#'), null);
  assert.equal(idDeCamara('x'.repeat(100) + '#EUW')!.length, 64);
});

test('cam_config: sólo https (o localhost) y sin ruta', () => {
  assert.deepEqual(leeConfigCamara(config), config);
  assert.equal(leeConfigCamara({ ...config, base: 'http://evil.example' }), null);
  assert.equal(leeConfigCamara({ ...config, base: 'https://cam.easyhud.net/x' }), null);
  assert.equal(leeConfigCamara({ ...config, base: 'file:///etc/passwd' }), null);
  assert.notEqual(leeConfigCamara({ ...config, base: 'http://localhost:8080' }), null);
  assert.equal(leeConfigCamara(null), null);
  assert.equal(leeConfigCamara({ ...config, params: '?a=b' })!.params, 'a=b');
  assert.equal(leeConfigCamara({ enable: 'sí' as never, base: 'https://vdo.ninja' })!.enable, false);
});

test('cuándo se publica', () => {
  assert.equal(debePublicar(config, 'A#B1'), true);
  assert.equal(debePublicar({ ...config, enable: false }, 'A#B1'), false);
  assert.equal(debePublicar({ ...config, room: '' }, 'A#B1'), false);
  assert.equal(debePublicar(config, 'sin-tag'), false);
  assert.equal(debePublicar(null, 'A#B1'), false);
});

test('dirección de publicación', () => {
  const u = new URL(urlPublicacion(config, 'Nick Name#1234'));
  assert.equal(u.origin, 'https://cam.easyhud.net');
  assert.equal(u.searchParams.get('push'), 'Nick_Name_H_1234');
  assert.equal(u.searchParams.get('room'), 'SALA9');
  assert.equal(u.searchParams.get('password'), 'abc-DEF_123');
  assert.equal(u.searchParams.get('wss2'), 'cam.easyhud.net/wss');
  for (const p of ['webcam', 'autostart', 'noaudio', 'cleanoutput']) assert.ok(u.searchParams.has(p), p);
  assert.equal(u.searchParams.has('videodevice'), false);
  assert.equal(new URL(urlPublicacion(config, 'A#B1', 'Logi C920')).searchParams.get('videodevice'), 'Logi C920');
  assert.throws(() => urlPublicacion(config, 'sin-tag'));
});
