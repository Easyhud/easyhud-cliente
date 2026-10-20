/**
 * Unirse a la sala personalizada por su código (beta, ESCRIBE sobre el cliente
 * de Riot). Lo hace el exe del jugador cuando el operador pulsa "Call players":
 * el servidor le manda el código de la sala y entra solo, sin que tenga que
 * escribirlo.
 *
 * ZONA GRIS: API local no oficial del cliente de Riot (ver `contexto.ts`).
 */

import type { ResolutorRiot } from './contexto.ts';
import { pide } from './peticion.ts';
import { leeParty } from './sala.ts';

export type ResultadoUnion = { ok: true; yaDentro: boolean } | { ok: false; error: string; estado?: number };

export async function uneASalaPorCodigo(
  riot: Pick<ResolutorRiot, 'contexto' | 'olvida'>,
  codigo: string,
): Promise<ResultadoUnion> {
  const c = await riot.contexto();
  if (c === null || c.glz === '') {
    return { ok: false, error: 'El cliente de Riot no está abierto (o VALORANT aún no ha dejado su registro).' };
  }
  try {
    // Si ya está en esa sala no se vuelve a unir (unirse otra vez lo sacaría y volvería a meter).
    const actual = await leeParty(c).catch(() => null);
    if (actual !== null && actual.party.InviteCode === codigo) return { ok: true, yaDentro: true };

    const r = await pide(`${c.glz}/parties/v1/players/joinbycode/${encodeURIComponent(codigo)}`, {
      metodo: 'POST',
      cabeceras: c.cabeceras,
    });
    if (r.estado === 401 || r.estado === 403) {
      riot.olvida(); // tokens viejos: el siguiente intento los renueva
      return { ok: false, error: `Riot rechazó la sesión (${r.estado}).`, estado: r.estado };
    }
    if (r.estado >= 300) return { ok: false, error: `joinbycode falló (${r.estado}).`, estado: r.estado };
    return { ok: true, yaDentro: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
