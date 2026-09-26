/**
 * Teclas globales del operador (especificación §7): la parte pura.
 *
 * El panel manda por `aplica-atajos` el objeto que guarda en su localStorage
 * (`overlay/panel/js/atajos.js`): una tecla por mando y `enabled` con un
 * booleano por mando. De ahí sale un plan de registro; quien lo ejecuta
 * (`modo-observador.ts`) habla con `globalShortcut`.
 *
 * Cambios respecto al cliente anterior:
 *   · el patrón admite F1–F24 (antes rechazaba F12–F19 y aceptaba F20, F21,
 *     F30…);
 *   · una tecla inválida ya no deja sin registrar las siguientes;
 *   · `showToast` no se registra: no hacía nada (pedía a la página un evento
 *     que nadie escucha) y sólo le robaba la tecla a otras aplicaciones.
 */

/** Mando → tipo de paquete que se envía por `obs_data` con `data: true`. */
export const MANDOS = {
  spikePlanted: 'spike_planted',
  techPause: 'tech_pause',
  leftTimeout: 'left_timeout',
  rightTimeout: 'right_timeout',
  switchKdaCredits: 'switch_kda_credits',
} as const;

export type Mando = keyof typeof MANDOS;

const VALIDA = /^(Ctrl\+|Alt\+|Shift\+)*([^\d+\s]|\d|F([1-9]|1\d|2[0-4]))$/;

export function teclaValida(tecla: string): boolean {
  return VALIDA.test(tecla);
}

export interface PlanAtajos {
  registros: Array<{ mando: Mando; tecla: string; type: string }>;
  invalidas: string[];
}

/** `null` si la carga no tiene la forma esperada (y entonces no se toca nada). */
export function planAtajos(carga: unknown): PlanAtajos | null {
  if (typeof carga !== 'object' || carga === null) return null;
  const c = carga as Record<string, unknown>;
  const enabled = c.enabled;
  if (typeof enabled !== 'object' || enabled === null) return null;
  const activos = enabled as Record<string, unknown>;

  const plan: PlanAtajos = { registros: [], invalidas: [] };
  for (const mando of Object.keys(MANDOS) as Mando[]) {
    const tecla = typeof c[mando] === 'string' ? (c[mando] as string).trim() : '';
    if (activos[mando] !== true || tecla === '') continue;
    if (!teclaValida(tecla)) {
      plan.invalidas.push(tecla);
      continue;
    }
    plan.registros.push({ mando, tecla, type: MANDOS[mando] });
  }
  return plan;
}
