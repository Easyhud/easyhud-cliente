/**
 * Sondeo del estado completo de GEP (`getInfo`): la red de seguridad de los avisos.
 *
 * Overwolf avisa de cada cambio (`new-info-update`), pero en algunos PCs deja de avisar de algunas claves
 * (vida, habilidades, marcador) aunque las tenga: el programa «funciona», ve eventos, y no recibe esos
 * datos. Preguntar de vez en cuando por el estado COMPLETO cubre ese hueco, y además enseña QUÉ claves
 * tiene Overwolf para esta partida, que es lo que hace falta para diagnosticar el PC.
 *
 * Sólo se reenvía lo que CAMBIÓ desde el sondeo anterior; así, si los avisos sí llegan, el sondeo no
 * duplica nada (el traductor ya ignora una vida repetida).
 */

export interface DatoInfo {
  key: string;
  value: unknown;
}

/** Las claves que se reenvían al traductor del jugador. El resto sólo se cuenta. */
const REENVIA = (k: string) => k === 'health' || k === 'abilities' || k === 'round_report' || k.startsWith('scoreboard');

/**
 * Aplana lo que devuelve `getInfo`. Según la versión viene como `{ info: { feature: { clave: valor } } }`,
 * `{ res: … }` o directamente `{ feature: { clave: valor } }`; se aceptan las tres.
 */
export function aplanaInfo(bruto: unknown): DatoInfo[] {
  let o: unknown = bruto;
  for (const envoltorio of ['res', 'info']) {
    if (typeof o === 'object' && o !== null && envoltorio in o) o = (o as Record<string, unknown>)[envoltorio];
  }
  if (typeof o !== 'object' || o === null) return [];
  const salida: DatoInfo[] = [];
  for (const [feature, sub] of Object.entries(o as Record<string, unknown>)) {
    if (typeof sub === 'object' && sub !== null && !Array.isArray(sub)) {
      for (const [key, value] of Object.entries(sub as Record<string, unknown>)) salida.push({ key, value });
    } else {
      salida.push({ key: feature, value: sub });
    }
  }
  return salida;
}

export interface OpcionesSondeo {
  /** Pide el estado completo a GEP (rechaza si no hay juego). */
  lee: () => Promise<unknown>;
  /** Un dato que cambió desde el sondeo anterior (sólo claves de `REENVIA`). */
  entrega: (dato: DatoInfo) => void;
  /** Las claves que tiene GEP ahora (para el diagnóstico). */
  alLeer?: (claves: string[]) => void;
  periodoMs?: number;
  log?: (texto: string) => void;
}

export class SondeoInfo {
  private reloj: NodeJS.Timeout | null = null;
  private leyendo = false;
  private readonly anterior = new Map<string, string>();
  private fallosSeguidos = 0;
  private readonly o: OpcionesSondeo;

  constructor(opciones: OpcionesSondeo) {
    this.o = opciones;
  }

  arranca(): void {
    if (this.reloj !== null) return;
    this.reloj = setInterval(() => void this.vuelta(), this.o.periodoMs ?? 1500);
    this.reloj.unref?.();
  }

  para(): void {
    if (this.reloj !== null) clearInterval(this.reloj);
    this.reloj = null;
  }

  /** Olvida lo anterior (partida nueva): lo que haya ahora se reenvía entero la primera vez. */
  reinicia(): void {
    this.anterior.clear();
  }

  async vuelta(): Promise<void> {
    if (this.leyendo) return;
    this.leyendo = true;
    try {
      const datos = aplanaInfo(await this.o.lee());
      this.fallosSeguidos = 0;
      this.o.alLeer?.([...new Set(datos.map((d) => d.key.replace(/_\d+$/, '_n')))].slice(0, 40));
      for (const d of datos) {
        if (!REENVIA(d.key) || d.value === null || d.value === undefined || d.value === '') continue;
        const huella = typeof d.value === 'string' ? d.value : JSON.stringify(d.value);
        if (this.anterior.get(d.key) === huella) continue;
        this.anterior.set(d.key, huella);
        this.o.entrega(d);
      }
    } catch (e) {
      // Sin juego, o GEP aún sin listo: no es un fallo; se anota una vez de cada diez para no llenar el log.
      if (this.fallosSeguidos++ % 10 === 0) this.o.log?.(`sondeo de GEP: sin respuesta (${e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)})`);
    } finally {
      this.leyendo = false;
    }
  }
}
