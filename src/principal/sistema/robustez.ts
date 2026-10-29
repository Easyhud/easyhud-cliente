/**
 * Piezas puras para que el programa no se quede colgado ni deje al operador sin salida en directo.
 *
 *   · `padreDeDialogo`: un diálogo «hijo» de una ventana escondida en la bandeja (o minimizada) en Windows se
 *     queda detrás de todo y nadie lo ve; mientras está abierto bloquea lo que lo espera (comprobaciones,
 *     actualización…). Sin ventana visible, el diálogo se muestra suelto.
 *   · `FiltroDialogos`: el mismo aviso no se apila diez veces (un fallo que se repite cada pocos segundos) y no hay
 *     más de unos pocos diálogos abiertos a la vez.
 *   · `LimitadorRecargas`: si la ventana se cae, se recarga sola; si se cae una y otra vez, se rinde y avisa
 *     (antes sería un bucle de recargas).
 *   · `ejecutaPasos`: «Reconnect everything» hace varias cosas independientes; si una falla, las demás se hacen.
 */

export interface VentanaMinima {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

/** La ventana a la que colgar un diálogo, o `null` (diálogo suelto) si no está a la vista. */
export function padreDeDialogo<T extends VentanaMinima>(v: T | null | undefined): T | null {
  if (v === null || v === undefined) return null;
  try {
    if (v.isDestroyed() || !v.isVisible() || v.isMinimized()) return null;
  } catch {
    return null;
  }
  return v;
}

/** Evita apilar diálogos repetidos y limita cuántos hay abiertos a la vez. */
export class FiltroDialogos {
  private readonly abiertos = new Set<string>();
  private readonly maximo: number;

  constructor(maximo = 4) {
    this.maximo = maximo;
  }

  /** `true` si se puede abrir (y queda anotado hasta `cierra`). */
  abre(clave: string): boolean {
    if (this.abiertos.has(clave) || this.abiertos.size >= this.maximo) return false;
    this.abiertos.add(clave);
    return true;
  }

  cierra(clave: string): void {
    this.abiertos.delete(clave);
  }

  get cuantos(): number {
    return this.abiertos.size;
  }
}

/** Motivos de `render-process-gone` que NO son una caída (la ventana se cerró a propósito). */
const SALIDAS_NORMALES = new Set(['clean-exit']);

/**
 * Cuenta las caídas recientes de la ventana. `registra` dice qué hacer: recargarla o, si ya se cayó `maximo`
 * veces en `ventanaMs`, rendirse (y que el operador lo sepa).
 */
export class LimitadorRecargas {
  private readonly caidas: number[] = [];
  private readonly maximo: number;
  private readonly ventanaMs: number;

  constructor(maximo = 3, ventanaMs = 60_000) {
    this.maximo = maximo;
    this.ventanaMs = ventanaMs;
  }

  registra(motivo: string, ahora: number): 'ignora' | 'recarga' | 'rinde' {
    if (SALIDAS_NORMALES.has(motivo)) return 'ignora';
    this.caidas.push(ahora);
    while (this.caidas.length > 0 && ahora - this.caidas[0] > this.ventanaMs) this.caidas.shift();
    return this.caidas.length > this.maximo ? 'rinde' : 'recarga';
  }
}

export interface Paso {
  nombre: string;
  ejecuta: () => Promise<string | undefined> | string | undefined;
}

/**
 * Ejecuta los pasos en orden y NO se detiene si uno falla: devuelve una línea por paso (lo que hizo o por qué
 * falló, en inglés, para decírselo al operador). Un paso que no devuelve texto no deja línea.
 */
export async function ejecutaPasos(pasos: readonly Paso[]): Promise<{ lineas: string[]; fallos: number }> {
  const lineas: string[] = [];
  let fallos = 0;
  for (const p of pasos) {
    try {
      const texto = await p.ejecuta();
      if (texto) lineas.push(texto);
    } catch (e) {
      fallos += 1;
      lineas.push(`${p.nombre} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { lineas, fallos };
}

/** Espera `promesa` como mucho `ms`; si no acaba, sigue (`false`) en vez de quedarse esperando para siempre. */
export async function conLimite(promesa: Promise<unknown>, ms: number): Promise<boolean> {
  let reloj: NodeJS.Timeout | undefined;
  const plazo = new Promise<false>((r) => {
    reloj = setTimeout(() => r(false), ms);
    reloj.unref?.();
  });
  try {
    return await Promise.race([promesa.then(() => true as const), plazo]);
  } finally {
    if (reloj !== undefined) clearTimeout(reloj);
  }
}
