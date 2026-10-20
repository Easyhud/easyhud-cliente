/**
 * Detecta, mirando la pantalla del juego, cuándo VALORANT está en un tiempo muerto o pausa técnica.
 *
 * En cada pausa el juego se pone EN GRIS (pierde todo el color menos el HUD). Eso se puede ver en una
 * miniatura minúscula de la pantalla: casi ningún píxel con color. La detección sólo mira esa miniatura
 * (96×54) 10 veces por segundo (sólo en la compra) en el PC del OBSERVADOR; no guarda nada ni sale nada de ahí. Jamás se usa
 * en el programa del jugador (el jugador no graba su pantalla).
 *
 * Para no marear: hacen falta varias muestras seguidas para cambiar (y menos para volver a color), y una
 * pantalla negra (carga, alt-tab) no cuenta como gris.
 */

export interface Fotograma {
  /** BGRA (lo que da Electron en Windows), 4 bytes por píxel. */
  datos: Uint8Array;
  ancho: number;
  alto: number;
}

export interface Medida {
  /** Fracción de píxeles con color apreciable (0..1). */
  color: number;
  /** Brillo medio (0..255). */
  brillo: number;
  /** Cuánto lleva QUIETO el timer del juego (ms). Si no viene, esa condición no se exige. */
  quietoMs?: number;
}

/** Cuánto tiene que llevar el timer quieto para creer que es una pausa (en la compra cambia cada segundo). */
export const TIMER_QUIETO_MS = 1500;

/** Diferencia entre el canal más y menos intenso a partir de la cual un píxel «tiene color». */
const UMBRAL_CROMA = 28;
const MIN_BRILLO = 25;

export function mide(f: Fotograma): Medida {
  const n = Math.floor(f.datos.length / 4);
  if (n === 0) return { color: 0, brillo: 0 };
  let colorido = 0;
  let luz = 0;
  for (let i = 0; i < n; i++) {
    const b = f.datos[i * 4];
    const g = f.datos[i * 4 + 1];
    const r = f.datos[i * 4 + 2];
    const max = Math.max(r, g, b);
    if (max - Math.min(r, g, b) > UMBRAL_CROMA) colorido++;
    luz += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { color: colorido / n, brillo: luz / n };
}

/** ¿Esta medida es la de un juego en gris? (poco color y no negro) */
export const esGris = (m: Medida, maxColor = 0.02): boolean => m.color < maxColor && m.brillo >= MIN_BRILLO;

/** Para DARLA POR TERMINADA hace falta que el color vuelva claramente (más que el umbral de entrada): histéresis. */
const COLOR_VUELTO = 0.08;

export interface OpcionesDetector {
  captura: () => Promise<Fotograma | null>;
  alCambiar: (activa: boolean) => void;
  intervaloMs?: number;
  /** Muestras grises seguidas para dar la pausa por puesta (100 ms cada una → ~0,2 s). */
  paraActivar?: number;
  /** Muestras con color seguidas para darla por terminada. */
  paraDesactivar?: number;
  log?: (m: string) => void;
}

export class DetectorPausa {
  private reloj: ReturnType<typeof setInterval> | null = null;
  private ocupado = false;
  private seguidas = 0;
  private primera = false;
  activa = false;

  private readonly o: OpcionesDetector;

  constructor(o: OpcionesDetector) {
    this.o = o;
  }

  arranca(): void {
    if (this.reloj !== null) return;
    this.reloj = setInterval(() => void this.muestra(), this.o.intervaloMs ?? 100);
    this.reloj.unref?.();
  }

  para(): void {
    if (this.reloj !== null) clearInterval(this.reloj);
    this.reloj = null;
    if (this.activa) {
      this.activa = false;
      this.o.alCambiar(false);
    }
    this.seguidas = 0;
  }

  /** Una muestra (público para las pruebas). */
  async muestra(): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      const f = await this.o.captura();
      if (f === null) return;
      this.procesa(mide(f));
    } catch (e) {
      this.o.log?.(`detector de pausa: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.ocupado = false;
    }
  }

  /** Una medida (de la captura propia o del flujo de vídeo). */
  procesa(m: Medida): void {
    if (!this.primera) {
      this.primera = true;
      this.o.log?.(`detector de pausa: primera medida correcta (color ${(m.color * 100).toFixed(1)} %, brillo ${m.brillo.toFixed(0)})`);
    }
    const negro = m.brillo < MIN_BRILLO;
    // Una pantalla negra no dice nada: no empuja ni a un lado ni al otro.
    if (negro) return;
    /*
     * Para EMPEZAR: el juego en GRIS **y** el timer QUIETO, las dos cosas a la vez.
     * Para TERMINAR: sólo que vuelva el color (claramente). El timer no cuenta aquí: durante la pausa el juego
     * puede dibujar cosas en esa zona y quitarla por eso hacía que la pausa se encendiera y apagara sola.
     */
    const gris = this.activa
      ? m.color < COLOR_VUELTO
      : esGris(m) && (m.quietoMs === undefined || m.quietoMs >= TIMER_QUIETO_MS);
    if (gris === this.activa) {
      this.seguidas = 0;
      return;
    }
    this.seguidas += 1;
    const hacen = gris ? (this.o.paraActivar ?? 2) : (this.o.paraDesactivar ?? 3);
    if (this.seguidas < hacen) return;
    this.seguidas = 0;
    this.activa = gris;
    this.o.log?.(`pausa detectada por pantalla: ${gris ? 'EMPIEZA (el juego se ve en gris)' : 'TERMINA (vuelve el color)'} — color ${(m.color * 100).toFixed(1)} %, brillo ${m.brillo.toFixed(0)}`);
    this.o.alCambiar(gris);
  }
}
