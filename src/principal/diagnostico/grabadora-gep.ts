/**
 * La grabadora de GEP: la «caja negra» de lo que Overwolf entrega.
 *
 * Para saber con certeza por qué a un PC le llegan unos datos y a otro no, hace falta ver EXACTAMENTE qué
 * recibe cada uno y cuándo. Esto guarda, sin coste:
 *   · una cuenta por clave (cuántas veces, cuándo la vio por primera y por última vez, y un ejemplo);
 *   · los últimos N datos en bruto, con su hora;
 *   · los sucesos del propio GEP (juego detectado, juego cerrado, privilegios, errores).
 * Los valores se recortan: es para diagnosticar, no para archivar la partida.
 */

export interface RegistroGep {
  /** Instante (ms desde 1970). */
  t: number;
  clase: 'info' | 'evento' | 'sondeo' | 'suceso';
  key: string;
  valor: string;
}

export interface FichaClave {
  n: number;
  primero: number;
  ultimo: number;
  /** El último valor visto, recortado. */
  muestra: string;
  /** De dónde llegó: avisos (`info`/`evento`) o el sondeo de `getInfo`. */
  via: Array<'info' | 'evento' | 'sondeo'>;
}

export interface InstantaneaGep {
  total: number;
  porClave: Record<string, FichaClave>;
  ultimos: RegistroGep[];
  sucesos: RegistroGep[];
}

const MAX_VALOR = 160;
const MAX_CLAVES = 80;

const normaliza = (clave: string): string => clave.replace(/_\d+$/, '_N').slice(0, 48);

const recorta = (v: unknown): string => {
  const t = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v) ?? '';
  return t.length > MAX_VALOR ? `${t.slice(0, MAX_VALOR)}…` : t;
};

export class GrabadoraGep {
  private readonly ahora: () => number;
  private readonly max: number;
  private readonly claves = new Map<string, FichaClave>();
  private readonly anillo: RegistroGep[] = [];
  private readonly sucesos: RegistroGep[] = [];
  private total = 0;

  constructor(max = 300, ahora: () => number = Date.now) {
    this.max = max;
    this.ahora = ahora;
  }

  /** Un dato de GEP (aviso de información, evento, o lo que dijo el sondeo de `getInfo`). */
  registra(clase: 'info' | 'evento' | 'sondeo', key: string, valor: unknown): void {
    const t = this.ahora();
    this.total += 1;
    const k = normaliza(key);
    let f = this.claves.get(k);
    if (f === undefined) {
      if (this.claves.size >= MAX_CLAVES) return;
      f = { n: 0, primero: t, ultimo: t, muestra: '', via: [] };
      this.claves.set(k, f);
    }
    f.n += 1;
    f.ultimo = t;
    f.muestra = recorta(valor);
    if (!f.via.includes(clase)) f.via.push(clase);

    this.anillo.push({ t, clase, key, valor: f.muestra });
    if (this.anillo.length > this.max) this.anillo.shift();
  }

  /** Un suceso del propio GEP: juego detectado/cerrado, privilegios, errores… */
  suceso(tipo: string, detalle = ''): void {
    this.sucesos.push({ t: this.ahora(), clase: 'suceso', key: tipo, valor: recorta(detalle) });
    if (this.sucesos.length > 60) this.sucesos.shift();
  }

  instantanea(): InstantaneaGep {
    const porClave: Record<string, FichaClave> = {};
    for (const [k, f] of [...this.claves.entries()].sort(([a], [b]) => a.localeCompare(b))) porClave[k] = { ...f, via: [...f.via] };
    return { total: this.total, porClave, ultimos: [...this.anillo], sucesos: [...this.sucesos] };
  }
}
