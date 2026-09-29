/**
 * Las direcciones del servidor de partidas.
 *
 * Ingesta (5100) y salida (5200) viven en el mismo host: la de salida se
 * deriva de la de ingesta cambiando el puerto. Es lo que exige también
 * `servidor-v2`.
 */

/** Normalización antes de abrir el socket de datos. */
export function normalizaIngesta(url: string): string {
  const u = url.trim();
  if (/^https?:\/\/[^/:]+:\d+/i.test(u)) return u;
  if (u.includes(':') && !/^http/i.test(u)) return `https://${u}`;
  const conEsquema = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return `${conEsquema}:5100`;
}

/** `:5100` (seguido de `/` o fin) → `:5200`. */
export function derivaSalida(ingesta: string): string {
  return ingesta.replace(/:5100(?=\/|$)/, ':5200');
}
