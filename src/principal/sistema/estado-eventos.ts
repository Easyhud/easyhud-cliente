/**
 * Disponibilidad de los eventos de Overwolf para VALORANT (especificación
 * §8.3). Sólo se registra en el log: el canal `set-event-status` del cliente
 * anterior no lo escuchaba nadie y no se reimplementa.
 */

const NOMBRES = ['unsupported', 'green', 'yellow', 'red', 'disabled'];

/** 0 unsupported · 1 green · 2 yellow · 3 red · 4 disabled; `null` = todo bien. */
export function estadoDeEventos(cuerpo: unknown, esJugador: boolean): number | null {
  const d = typeof cuerpo === 'object' && cuerpo !== null ? (cuerpo as Record<string, unknown>) : {};
  if (d.state === 1) return null;
  if (d.disabled === true) return 4;
  const features = Array.isArray(d.features) ? (d.features as Array<Record<string, unknown>>) : [];
  const de = (nombre: string) => {
    const f = features.find((x) => x?.name === nombre);
    return typeof f?.state === 'number' ? f.state : 0;
  };
  const estado = esJugador ? Math.max(de('match_info'), de('me')) : de('match_info');
  return estado;
}

export function nombreEstado(n: number): string {
  return NOMBRES[n] ?? String(n);
}

export async function compruebaEventos(esJugador: boolean, log: (t: string) => void): Promise<void> {
  try {
    const r = await fetch('https://game-events-status.overwolf.com/21640_prod.json', { signal: AbortSignal.timeout(8000) });
    const estado = estadoDeEventos(await r.json(), esJugador);
    if (estado !== null) log(`eventos de Overwolf para VALORANT: ${nombreEstado(estado)} (${estado})`);
    else log('eventos de Overwolf para VALORANT: todo en verde');
  } catch (e) {
    log(`no se pudo consultar el estado de los eventos: ${e instanceof Error ? e.message : String(e)}`);
  }
}
