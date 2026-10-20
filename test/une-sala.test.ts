/**
 * Unirse a la sala por código contra un "servidor de partidas de Riot" de mentira.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { uneASalaPorCodigo } from '../src/principal/riot/une-sala.ts';
import type { ContextoRiot } from '../src/principal/riot/contexto.ts';

const cerrar: Server[] = [];
after(() => {
  for (const s of cerrar) s.close();
});

/** `codigoActual`: el código de la party en la que ya está el jugador ('' = no está en ninguna). */
async function glzFalso(codigoActual: string, respuestaUnion = 200) {
  const llamadas: string[] = [];
  const s = createServer((req, res) => {
    llamadas.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/parties/v1/players/puuid-yo') {
      res.end(JSON.stringify(codigoActual === '' ? {} : { CurrentPartyID: 'party-1' }));
    } else if (req.method === 'GET' && req.url === '/parties/v1/parties/party-1') {
      res.end(JSON.stringify({ InviteCode: codigoActual }));
    } else if (req.method === 'POST' && req.url === '/parties/v1/players/joinbycode/ABC123') {
      res.statusCode = respuestaUnion;
      res.end('{}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const puerto = await new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
  cerrar.push(s);
  let olvidado = false;
  const contexto: ContextoRiot = { puuid: 'puuid-yo', glz: `http://127.0.0.1:${puerto}`, pd: '', region: '', cabeceras: { 'X-Prueba': '1' } };
  return { llamadas, riot: { contexto: async () => contexto, olvida: () => (olvidado = true) }, olvidado: () => olvidado };
}

test('se une a la sala por código cuando no está en ella', async () => {
  const g = await glzFalso('');
  assert.deepEqual(await uneASalaPorCodigo(g.riot, 'ABC123'), { ok: true, yaDentro: false });
  assert.ok(g.llamadas.includes('POST /parties/v1/players/joinbycode/ABC123'));
});

test('si ya está en esa sala no se vuelve a unir', async () => {
  const g = await glzFalso('ABC123');
  assert.deepEqual(await uneASalaPorCodigo(g.riot, 'ABC123'), { ok: true, yaDentro: true });
  assert.equal(g.llamadas.some((l) => l.startsWith('POST')), false);
});

test('si está en otra sala, entra en la del código', async () => {
  const g = await glzFalso('OTRA99');
  assert.deepEqual(await uneASalaPorCodigo(g.riot, 'ABC123'), { ok: true, yaDentro: false });
});

test('errores: Riot cerrado, código rechazado y sesión caducada', async () => {
  const sinRiot = { contexto: async () => null, olvida: () => undefined };
  const a = await uneASalaPorCodigo(sinRiot, 'ABC123');
  assert.equal(a.ok, false);

  const rechazo = await glzFalso('', 404);
  const r = await uneASalaPorCodigo(rechazo.riot, 'ABC123');
  assert.deepEqual(r, { ok: false, error: 'joinbycode falló (404).', estado: 404 });

  const caducada = await glzFalso('', 401);
  assert.equal((await uneASalaPorCodigo(caducada.riot, 'ABC123')).ok, false);
  assert.equal(caducada.olvidado(), true, 'tras un 401 se olvidan los tokens');
});
