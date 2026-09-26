/**
 * Las cargas que viajan al servidor de partidas y la lectura de sus respuestas.
 *
 * Contrato (especificación §0.4 y `servidor-v2/docs/especificacion.md` §3):
 * cada evento lleva UN argumento que es una cadena JSON. Aquí sólo se
 * construyen objetos; `conexion.ts` los serializa al emitir.
 */

export interface Equipo {
  name: string;
  tricode: string;
  url: string;
  attackStart: boolean;
}

/** Punto de partida neutro: la configuración real la gobierna el panel por `/operador`. */
export function toolsDataInicial() {
  return {
    seriesInfo: { needed: 1, wonLeft: 0, wonRight: 0, mapInfo: [] as unknown[] },
    seedingInfo: { left: '', right: '' },
    tournamentInfo: { logoUrl: '', backdropUrl: '', timeoutDuration: 60 },
    timeoutDuration: 60,
    timeoutCounter: { max: 2, left: 2, right: 2 },
    sponsorInfo: { enabled: false, duration: 5, sponsors: [] as unknown[] },
    watermarkInfo: { brandWatermark: false, customTextEnabled: false, customText: '' },
    playercamsInfo: { enable: false, identifier: '', secret: '', endTime: 0 },
    roundWinBox: { type: 'disabled', sponsors: [] as unknown[] },
  };
}

/** El nombre del observador sale del campo `c` del cuerpo del token; si no, `Observer`. */
export function nombreDelToken(token: string): string {
  const punto = token.lastIndexOf('.');
  if (punto <= 0) return 'Observer';
  try {
    const cuerpo: unknown = JSON.parse(Buffer.from(token.slice(0, punto), 'base64url').toString('utf8'));
    const c = typeof cuerpo === 'object' && cuerpo !== null ? (cuerpo as { c?: unknown }).c : undefined;
    return typeof c === 'string' && c.trim() !== '' ? c : 'Observer';
  } catch {
    return 'Observer';
  }
}

export interface DatosLogonObservador {
  version: string;
  token: string;
  grupo: string;
  secreto: string;
}

export function logonObservador(d: DatosLogonObservador) {
  return {
    type: 'authenticate',
    clientVersion: d.version,
    obsName: nombreDelToken(d.token),
    key: d.token,
    groupCode: d.grupo.toUpperCase(),
    groupSecret: d.secreto,
    leftTeam: { name: '', tricode: '', url: '', attackStart: true } satisfies Equipo,
    rightTeam: { name: '', tricode: '', url: '', attackStart: false } satisfies Equipo,
    toolsData: toolsDataInicial(),
  };
}

export interface DatosLogonJugador {
  version: string;
  nombre: string;
  puuid: string;
  /** Por matchId (partida en curso)… */
  matchId?: string;
  /** …o por grupo ("Call players"). */
  grupo?: string;
}

export function logonJugador(d: DatosLogonJugador) {
  const base = { type: 'aux_authenticate', clientVersion: d.version, name: d.nombre, matchId: d.matchId ?? '' };
  return d.grupo !== undefined ? { ...base, groupCode: d.grupo, playerId: d.puuid } : { ...base, playerId: d.puuid };
}

/** Tabla F: el motivo del rechazo, en un texto que el operador entienda. */
export function motivoAmable(reason: unknown): string {
  const r = typeof reason === 'string' ? reason : '';
  const m = r.toLowerCase();
  if (m.includes('still live') || (m.includes('exists') && m.includes('group code'))) {
    return (
      "There's already a live broadcast on this group code.\n\n" +
      "It's usually another observer still connected, or this one that didn't close cleanly. " +
      'Close the other observer, wait about a minute for it to drop, then open again.'
    );
  }
  if (m.includes('not compatible') || m.includes('compatible with server')) {
    return 'This observer version is out of date. Update Easy HUD and try again.';
  }
  if (m.includes('not found')) return 'That match is no longer live on the server. Start it again from the observer.';
  if (m.includes('expired')) return 'Your broadcast permit has expired. Sign in again to renew it.';
  if (m.includes('invalid')) return "The server didn't accept these credentials. Check your account and try again.";
  return r === '' ? 'Connection failed.' : r;
}

/** Decodifica una carga recibida (cadena JSON u objeto). `null` si no es un objeto. */
export function leeCarga(msg: unknown): Record<string, unknown> | null {
  let v: unknown = msg;
  if (typeof msg === 'string') {
    try {
      v = JSON.parse(msg);
    } catch {
      return null;
    }
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
