/**
 * Logon sin acuse: el reintento es una reconexión interna (no un cierre) y vuelve a hacer el logon.
 * Socket falso y temporizadores simulados: no hay red ni esperas reales.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { EnlaceIngesta, type Avisos } from '../src/principal/enlace/conexion.ts';

/** Se comporta como el de socket.io: `disconnect()` emite `disconnect` al instante, `connect()` emite `connect`. */
class SocketFalso extends EventEmitter {
  io = new EventEmitter();
  active = true;
  conectado = false;
  emitidos: Array<{ evento: string; carga: unknown }> = [];
  cerrado = false;
  override emit(evento: string, ...args: unknown[]): boolean {
    // Los eventos que el cliente envía al servidor se anotan; los que llegan se despachan.
    if (evento === 'obs_logon' || evento === 'aux_logon') {
      this.emitidos.push({ evento, carga: args[0] });
      return true;
    }
    return super.emit(evento, ...args);
  }
  connect(): this {
    this.conectado = true;
    super.emit('connect');
    return this;
  }
  disconnect(): this {
    if (this.conectado) {
      this.conectado = false;
      super.emit('disconnect', 'io client disconnect');
    }
    return this;
  }
  close(): this {
    this.cerrado = true;
    return this.disconnect();
  }
  logones(): number {
    return this.emitidos.filter((e) => e.evento === 'obs_logon').length;
  }
}

function monta() {
  const estados: string[] = [];
  const registro: string[] = [];
  const autenticados: unknown[] = [];
  const avisos: Avisos = {
    estado: (m) => estados.push(m),
    dialogo: () => {},
    autenticado: (i) => autenticados.push(i),
    desconectado: () => registro.push('desconectado'),
    log: () => {},
  };
  const falso = new SocketFalso();
  const enlace = new EnlaceIngesta({
    version: '0.0.0-test',
    avisos,
    esperaAckMs: 10_000,
    reintentoAckBaseMs: 1000,
    crearSocket: () => falso as unknown as Socket,
  });
  enlace.abre('http://localhost:1', { rol: 'observador', token: 'tok', grupo: 'grp' });
  return { falso, enlace, estados, registro, autenticados };
}

const acuse = (falso: SocketFalso) => falso.emit('obs_logon_ack', JSON.stringify({ type: 'authenticate', value: true, reason: 'secreto' }));

test('sin acuse: se reintenta sin cerrar y se vuelve a emitir el logon; el acuse tardío del 2.º intento autentica', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { falso, enlace, estados, autenticados } = monta();

  falso.connect(); // 1.er logon
  assert.equal(falso.logones(), 1);

  t.mock.timers.tick(10_000); // vence el plazo del acuse
  assert.equal(falso.cerrado, false, 'el socket no se cierra');
  assert.ok(falso.listenerCount('connect') > 0, 'conserva los oyentes');
  assert.equal(enlace.abierto, true);
  assert.equal(estados.includes('Connection Closed'), false);
  assert.equal(estados.includes('Disconnected'), false);

  t.mock.timers.tick(1000); // espera creciente (1 s en el primer reintento) y reabre
  assert.equal(falso.logones(), 2, 'vuelve a hacer el logon');

  acuse(falso); // el acuse llega tarde, ya en el 2.º intento
  assert.equal(enlace.autenticado, true);
  assert.equal(autenticados.length, 1);
  assert.equal(estados.at(-1), 'Connected');
});

test('tras varios reintentos sin acuse pasa a «Connection Failed» y cierra', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { falso, enlace, estados } = monta();
  falso.connect();
  // 5 reintentos con espera creciente (1, 2, 3, 4, 5 s) y el plazo de cada logon.
  for (let n = 1; n <= 5; n++) {
    t.mock.timers.tick(10_000);
    assert.equal(enlace.abierto, true);
    t.mock.timers.tick(1000 * n);
    assert.equal(falso.logones(), n + 1);
  }
  t.mock.timers.tick(10_000); // el sexto plazo agota los reintentos
  assert.equal(enlace.abierto, false);
  assert.equal(estados.at(-1), 'Connection Failed');
  assert.equal(estados.includes('Connection Closed'), false);
});
