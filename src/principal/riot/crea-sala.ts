/**
 * Crear la sala de torneo (beta, ESCRIBE sobre el cliente de Riot). Sólo
 * observador.
 *
 * Pasos en orden, al primer fallo se devuelve el error. `AllowGameModifiers`
 * va activado a propósito: permite pausar el reloj de la partida.
 */

import type { ResolutorRiot } from './contexto.ts';
import { leeParty } from './sala.ts';
import { objeto, pide } from './peticion.ts';

export type ResultadoSala = { ok: true; codigo: string } | { ok: false; error: string };

const MAPA = '/Game/Maps/Ascent/Ascent';
const MODO = '/Game/GameModes/Bomb/BombGameMode.BombGameMode_C';
const POD_DE_RESERVA = 'aresriot.aws-scl1-prod.latam-gp-santiago-1';

export async function creaSalaTorneo(riot: ResolutorRiot): Promise<ResultadoSala> {
  const c = await riot.contexto();
  if (c === null || c.glz === '') return { ok: false, error: 'El cliente de Riot no está abierto.' };

  const p = await leeParty(c).catch(() => null);
  if (p === null) return { ok: false, error: 'No hay party activa en el cliente de Riot.' };
  const base = `${c.glz}/parties/v1/parties/${p.id}`;
  const post = (ruta: string, cuerpo?: unknown) => pide(`${base}${ruta}`, { metodo: 'POST', cabeceras: c.cabeceras, cuerpo });
  const falla = (que: string, estado: number): ResultadoSala => ({ ok: false, error: `${que} falló (${estado}).` });

  try {
    const hecha = await post('/makecustomgame');
    if (hecha.estado >= 300) return falla('makecustomgame', hecha.estado);

    const actual = await pide(base, { cabeceras: c.cabeceras });
    let pod = objeto(objeto(objeto(actual.json()).CustomGameData).Settings).GamePod;
    if (typeof pod !== 'string' || pod === '') {
      const conf = await pide(`${c.glz}/parties/v1/parties/customgameconfigs`, { cabeceras: c.cabeceras }).catch(() => null);
      const pods = objeto(conf?.json()).GamePodPingServiceInfo;
      const lista = typeof pods === 'object' && pods !== null ? Object.keys(pods) : [];
      pod = lista.find((x) => c.region !== '' && x.includes(c.region)) ?? lista[0] ?? POD_DE_RESERVA;
    }
    const ajustes = await post('/customgamesettings', {
      Map: MAPA,
      Mode: MODO,
      UseBots: false,
      GamePod: pod,
      GameRules: {
        AllowGameModifiers: 'true',
        PlayOutAllRounds: 'false',
        SkipMatchHistory: 'false',
        TournamentMode: 'true',
        IsOvertimeWinByTwo: 'true',
      },
    });
    if (ajustes.estado >= 300) return falla('customgamesettings', ajustes.estado);

    const espectador = await post('/customgamemembership/TeamSpectate', { playerToPutOnTeam: c.puuid });
    if (espectador.estado >= 300) return falla('mover a espectador', espectador.estado);

    const cerrada = await post('/accessibility', { accessibility: 'CLOSED' });
    if (cerrada.estado >= 300) return falla('cerrar sala', cerrada.estado);

    const invitacion = await post('/invitecode');
    const codigo = objeto(invitacion.json()).InviteCode;
    if (invitacion.estado >= 300 || typeof codigo !== 'string') return falla('generar código', invitacion.estado);
    return { ok: true, codigo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
