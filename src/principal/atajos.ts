/**
 * Teclas globales del operador: la parte pura.
 *
 * El panel manda por `aplica-atajos` el objeto que guarda en su localStorage
 * (`overlay/panel/js/atajos.js`): una tecla por mando y `enabled` con un
 * booleano por mando. De ahí sale un plan de registro; quien lo ejecuta
 * (`modo-observador.ts`) habla con `globalShortcut`.
 *
 * Reglas:
 *   · el patrón admite F1–F24;
 *   · una tecla inválida no deja sin registrar las siguientes;
 *   · `showToast` no se registra: no hace nada (pedía a la página un evento
 *     que nadie escucha) y sólo le robaría la tecla a otras aplicaciones.
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

type Registro = PlanAtajos['registros'][number];

/** Cómo se llama cada mando para el operador (en los avisos). */
export const NOMBRES_MANDOS: Record<Mando, string> = {
  spikePlanted: 'Spike planted',
  techPause: 'Tech pause',
  leftTimeout: 'Left timeout',
  rightTimeout: 'Right timeout',
  switchKdaCredits: 'Switch KDA / Credits',
};

/** Las combinaciones que el propio programa tiene registradas (ver `principal.ts`). */
export const TECLAS_RESERVADAS: ReadonlyArray<{ tecla: string; para: string }> = [
  { tecla: 'Ctrl+Alt+O', para: 'the operator overlay' },
  { tecla: 'Ctrl+Alt+R', para: 'Reconnect everything' },
];

/**
 * Forma canónica para comparar combinaciones: sin mayúsculas, `Control` = `Ctrl` y los modificadores en orden
 * fijo (`Alt+Ctrl+K` y `Ctrl+Alt+k` son la misma tecla para Windows).
 */
export function normalizaTecla(tecla: string): string {
  const partes = tecla.trim().split('+');
  const final = (partes.pop() ?? '').toLowerCase();
  const mods = new Set(partes.map((p) => p.trim().toLowerCase().replace(/^control$/, 'ctrl')));
  return [...['ctrl', 'alt', 'shift'].filter((m) => mods.has(m)), final].join('+');
}

export interface Choque {
  mando: Mando;
  tecla: string;
  /** Qué pasa, en inglés y dicho al operador. */
  motivo: string;
}

/**
 * Antes de registrar nada: las teclas que NO se pueden registrar por culpa del propio programa. Dos mandos con
 * la misma tecla (Windows sólo deja registrar una: la segunda fallaba y se acusaba a «otro programa») o una
 * combinación que el programa ya usa para sí mismo. El primero que la pide se queda con ella.
 */
export function separaChoques(registros: readonly Registro[]): { libres: Registro[]; choques: Choque[] } {
  const libres: Registro[] = [];
  const choques: Choque[] = [];
  const vistas = new Map<string, Registro>();
  for (const r of registros) {
    const clave = normalizaTecla(r.tecla);
    const reservada = TECLAS_RESERVADAS.find((x) => normalizaTecla(x.tecla) === clave);
    const previa = vistas.get(clave);
    if (reservada !== undefined) {
      choques.push({ mando: r.mando, tecla: r.tecla, motivo: `${r.tecla} is reserved by Easy HUD (${reservada.para})` });
    } else if (previa !== undefined) {
      choques.push({ mando: r.mando, tecla: r.tecla, motivo: `${r.tecla} is already used for "${NOMBRES_MANDOS[previa.mando]}"` });
    } else {
      vistas.set(clave, r);
      libres.push(r);
    }
  }
  return { libres, choques };
}

/** Lo que no se pudo registrar, por causa. */
export interface AtajosFallidos {
  /** Otro programa tiene la combinación. */
  ocupadas: Registro[];
  /** Combinaciones con las que Windows no puede (teclas que no existen en un atajo global). */
  ilegales: Registro[];
  /** Repetidas o reservadas (ver `separaChoques`). */
  choques: Choque[];
  /** Con un formato que el programa no admite (ver `teclaValida`). */
  invalidas: string[];
}

/** El aviso al operador (todas las causas en un solo diálogo), o `null` si todo funciona. */
export function textoAtajosFallidos(f: AtajosFallidos): string | null {
  const lineas: string[] = [];
  for (const r of f.ocupadas) lineas.push(`• ${NOMBRES_MANDOS[r.mando]}: ${r.tecla} is already used by another program`);
  for (const c of f.choques) lineas.push(`• ${NOMBRES_MANDOS[c.mando]}: ${c.motivo}`);
  for (const r of f.ilegales) lineas.push(`• ${NOMBRES_MANDOS[r.mando]}: ${r.tecla} cannot be used as a global hotkey`);
  for (const t of f.invalidas) lineas.push(`• ${t} is not a valid hotkey (use one key, like K or F9, with optional Ctrl/Alt/Shift)`);
  if (lineas.length === 0) return null;
  return `These hotkeys will NOT work:\n\n${lineas.join('\n')}\n\nChange them in the panel's hotkey settings, or close the other program.`;
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
