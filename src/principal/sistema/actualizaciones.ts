/**
 * Comprobación de actualizaciones (especificación §8.1). Sólo perfil `normal`:
 * los instaladores fijos (observer/player) no se actualizan solos.
 *
 * Mira la primera release de `Easyhud/easyhud-client` en GitHub. Un 404
 * (repositorio privado o sin releases) se registra y se sigue EN SILENCIO.
 */

export const REPO = 'Easyhud/easyhud-client';
export const URL_RELEASES = `https://api.github.com/repos/${REPO}/releases`;
export const URL_ULTIMA = `https://github.com/${REPO}/releases/latest`;

type Tripleta = [number, number, number];

export function leeSemver(v: unknown): Tripleta | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** >0 si a es mayor que b. */
export function comparaSemver(a: Tripleta, b: Tripleta): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export type Veredicto =
  | { tipo: 'al-dia' }
  | { tipo: 'nueva'; nombre: string; version: string }
  | { tipo: 'fallo'; motivo: string }
  | { tipo: 'silencio'; motivo: string };

/** La decisión a partir de la respuesta de GitHub (función pura, probada). */
export function evalua(estado: number, cuerpo: unknown, actual: string): Veredicto {
  if (estado === 404) return { tipo: 'silencio', motivo: 'repositorio de releases no accesible (404)' };
  if (estado !== 200) return { tipo: 'fallo', motivo: `GitHub respondió ${estado}` };
  const primera: unknown = Array.isArray(cuerpo) ? cuerpo[0] : undefined;
  if (primera === undefined) return { tipo: 'silencio', motivo: 'sin releases publicadas' };
  const r = typeof primera === 'object' && primera !== null ? (primera as Record<string, unknown>) : {};
  const etiqueta = typeof r.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
  const remota = leeSemver(etiqueta);
  const local = leeSemver(actual);
  if (remota === null || local === null) return { tipo: 'fallo', motivo: `versión no válida (${etiqueta} / ${actual})` };
  if (comparaSemver(remota, local) > 0) {
    return { tipo: 'nueva', version: etiqueta, nombre: typeof r.name === 'string' && r.name !== '' ? r.name : etiqueta };
  }
  return { tipo: 'al-dia' };
}

export async function compruebaActualizacion(actual: string): Promise<Veredicto> {
  try {
    const r = await fetch(URL_RELEASES, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EasyHUD-Client' },
      signal: AbortSignal.timeout(8000),
    });
    const cuerpo: unknown = r.status === 200 ? await r.json() : null;
    return evalua(r.status, cuerpo, actual);
  } catch (e) {
    return { tipo: 'fallo', motivo: e instanceof Error ? e.message : String(e) };
  }
}
