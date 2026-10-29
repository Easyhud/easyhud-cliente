/**
 * Diagnóstico del programa del jugador.
 *
 * Reúne en un solo sitio cómo está el programa por dentro —GEP, juego, eventos, conexión, cámara,
 * errores, paquetes enviados— para tres cosas:
 *   · contárselo al servidor en cada latido de presencia (el panel lo enseña por jugador);
 *   · enseñárselo al propio jugador en su ventana, con lo que falla y qué hacer;
 *   · decidir cuándo hay que avisarle (notificación) en vez de dejarlo fallar en silencio.
 *
 * Todo puro (sin Electron): se alimenta con los `fija…` / `cuenta…` y se lee con `instantanea()`,
 * `alertas()` y `texto()`. El reloj se inyecta para probarlo.
 */

import type { Comprobacion } from '../sistema/arranque.ts';

export type EstadoGep = 'esperando' | 'listo' | 'caido' | 'sin-api';
export type EstadoDatos = 'cerrada' | 'conectando' | 'conectada';

/** Lo que se manda al servidor (ver `servidor-v2/src/diagnostico.ts`: es el mismo contrato). */
export interface CargaDiagnostico {
  version: string;
  gep: EstadoGep;
  gepVersion: string;
  juegoAbierto: boolean;
  juegoDetectado: boolean;
  eventosHace: number | null;
  /** El programa se considera espectador: no manda vida ni habilidades. */
  espectador: boolean;
  /** Otros programas que compiten por el mismo GEP (Easy HUD / ValoSpectra / Overwolf abiertos a la vez). */
  conflictos: string[];
  /** Las claves que tiene GEP del juego AHORA (`getInfo`), aunque no haya avisado de ellas. */
  infoClaves: string[];
  /** Cuántos datos de GEP han llegado, por clave (sin sufijo numérico): para ver QUÉ entrega Overwolf. */
  claves: Record<string, number>;
  datos: EstadoDatos;
  red: string;
  riot: string;
  camara: { permitida: boolean; publicando: boolean; error: string };
  enviados: Record<string, number>;
  errores: string[];
}

/** Lo que sabe de la red la presencia (el latido que habla con el servidor). */
export interface EstadoRed {
  /** El socket de presencia está conectado. */
  conectada: boolean;
  /** Desde cuándo (ms) está en el estado actual. */
  desdeMs: number;
  /** Ha llegado a conectar alguna vez desde que arrancó el programa. */
  conectoAlgunaVez: boolean;
  /** Ya se ha mandado algún latido en esta conexión (sin puuid no hay latido, y entonces el silencio no es culpa del servidor). */
  latiendo: boolean;
  /** El servidor contesta a los latidos (acuse recibido hace poco). */
  oidoPorServidor: boolean;
  /** Último fallo de conexión visto (vacío = ninguno). */
  ultimoFallo: string;
  intentos: number;
}

export type Nivel = 'error' | 'aviso';

export interface Alerta {
  /** Estable: sirve para no repetir la notificación. */
  id: string;
  nivel: Nivel;
  titulo: string;
  detalle: string;
}

const MAX_ERRORES = 6;

/** Las comprobaciones de arranque que no tienen alerta propia en `alertas()`. */
const ALERTAS_DE_ARRANQUE = new Set<string>(['orden', 'admin', 'version', 'eventos', 'temporal']);

export class Diagnostico {
  private readonly version: string;
  private readonly ahora: () => number;
  private readonly inicio: number;

  private estadoGep: EstadoGep = 'esperando';
  private versionGep = '';
  private abierto = false;
  private detectado = false;
  private detectadoDesde: number | null = null;
  private abiertoDesde: number | null = null;
  private ultimoEvento: number | null = null;
  private estadoDatos: EstadoDatos = 'cerrada';
  private esEspectador = false;
  private conflictos: string[] = [];
  private infoClaves: string[] = [];
  private readonly claves: Record<string, number> = {};
  private motivoRed = '';
  private estadoRiot = '';
  private tieneRiotId = false;
  private cam = { permitida: false, publicando: false, error: '' };
  private readonly enviados: Record<string, number> = {};
  private readonly errores: string[] = [];
  private comprobaciones: Comprobacion[] = [];

  constructor(version: string, ahora: () => number = Date.now) {
    this.version = version;
    this.ahora = ahora;
    this.inicio = ahora();
  }

  /* ── Entradas ──────────────────────────────────────────────────────────── */

  fijaGep(estado: EstadoGep, version = ''): void {
    this.estadoGep = estado;
    if (version !== '') this.versionGep = version;
  }

  fijaJuegoDetectado(si: boolean): void {
    if (si && !this.detectado) this.detectadoDesde = this.ahora();
    if (!si) this.detectadoDesde = null;
    this.detectado = si;
  }

  fijaJuegoAbierto(si: boolean): void {
    if (si && !this.abierto) this.abiertoDesde = this.ahora();
    if (!si) this.abiertoDesde = null;
    this.abierto = si;
  }

  /** Llegó un dato de GEP; `clave` es su nombre (`health`, `scoreboard_3`…), para saber qué entrega Overwolf. */
  cuentaEvento(clave = ''): void {
    this.ultimoEvento = this.ahora();
    const k = clave.replace(/_\d+$/, '_N').replace(/[^a-z_0-9]/gi, '').toLowerCase().slice(0, 40);
    if (k === '') return;
    if (this.claves[k] === undefined && Object.keys(this.claves).length >= 24) return;
    this.claves[k] = (this.claves[k] ?? 0) + 1;
  }

  fijaEspectador(si: boolean): void {
    this.esEspectador = si;
  }

  /** Lo que `getInfo` dice que GEP tiene ahora. */
  fijaInfoClaves(lista: string[]): void {
    this.infoClaves = lista.slice(0, 40).map((x) => x.replace(/[^a-z_0-9]/gi, '').toLowerCase().slice(0, 40)).filter((x) => x !== '');
  }

  /** Otros programas que compiten por el GEP (vacío = ninguno). */
  fijaConflictos(lista: string[]): void {
    this.conflictos = lista.slice(0, 6).map((x) => x.slice(0, 80));
  }

  fijaDatos(estado: EstadoDatos): void {
    this.estadoDatos = estado;
  }

  /** El último motivo de fallo de red; vacío cuando todo va bien. */
  fijaRed(motivo: string): void {
    this.motivoRed = motivo.slice(0, 160);
  }

  fijaRiot(texto: string, tienePuuid?: boolean): void {
    this.estadoRiot = texto.slice(0, 160);
    if (tienePuuid !== undefined) this.tieneRiotId = tienePuuid;
  }

  /** El último resultado de las comprobaciones de arranque (`sistema/arranque.ts`). */
  fijaComprobaciones(lista: Comprobacion[]): void {
    this.comprobaciones = lista;
  }

  fijaCamara(c: { permitida: boolean; publicando: boolean; error: string }): void {
    this.cam = { permitida: c.permitida, publicando: c.publicando, error: c.error.slice(0, 160) };
  }

  /** Se mandó un paquete de datos de este tipo. */
  cuentaEnvio(tipo: string): void {
    if (!/^[a-z_0-9]{1,40}$/.test(tipo)) return;
    this.enviados[tipo] = (this.enviados[tipo] ?? 0) + 1;
  }

  /** Un error que merece verse (se guardan los últimos). */
  registraError(texto: string): void {
    const t = texto.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (t === '' || this.errores.at(-1) === t) return;
    this.errores.push(t);
    if (this.errores.length > MAX_ERRORES) this.errores.shift();
  }

  /* ── Salidas ───────────────────────────────────────────────────────────── */

  instantanea(datos: EstadoDatos = this.estadoDatos): CargaDiagnostico {
    const t = this.ahora();
    return {
      version: this.version,
      gep: this.estadoGep,
      gepVersion: this.versionGep,
      juegoAbierto: this.abierto,
      juegoDetectado: this.detectado,
      eventosHace: this.ultimoEvento === null ? null : Math.max(0, t - this.ultimoEvento),
      espectador: this.esEspectador,
      conflictos: [...this.conflictos],
      infoClaves: [...this.infoClaves],
      claves: { ...this.claves },
      datos,
      red: this.motivoRed,
      riot: this.estadoRiot,
      camara: { ...this.cam },
      enviados: { ...this.enviados },
      errores: [...this.errores],
    };
  }

  /**
   * Lo que va mal ahora mismo, de lo más grave a lo menos. Cada regla espera un margen para no gritar por
   * algo que se arregla solo (el arranque, una reconexión de segundos).
   */
  alertas(red: EstadoRed): Alerta[] {
    const t = this.ahora();
    const alertas: Alerta[] = [];
    const desdeInicio = t - this.inicio;

    /* Al ARRANCAR (inicio de Windows, red aún sin levantar) se da más margen que ante una caída ya con
       conexión previa: antes avisaba de «no alcanzo el servidor» a los 20 s de abrir el programa. */
    const margenCaida = red.conectoAlgunaVez ? 25_000 : 90_000;
    if (!red.conectada && red.desdeMs >= margenCaida) {
      alertas.push({
        id: 'servidor',
        nivel: 'error',
        titulo: 'Cannot reach the Easy HUD server',
        detalle:
          (red.ultimoFallo !== '' ? `${red.ultimoFallo}. ` : '') +
          'Check your internet connection, VPN or firewall. The app keeps retrying by itself.',
      });
    } else if (red.conectada && red.latiendo && !red.oidoPorServidor && red.desdeMs >= 45_000) {
      alertas.push({
        id: 'servidor-mudo',
        nivel: 'aviso',
        titulo: 'The server is not answering',
        detalle: 'The connection is open but the server does not acknowledge this app. Reconnecting…',
      });
    }

    if (this.estadoGep === 'caido' || this.estadoGep === 'sin-api') {
      alertas.push({
        id: 'gep-caido',
        nivel: 'error',
        titulo: 'Overwolf game events failed',
        detalle: 'The Overwolf package that reads VALORANT crashed. Restart Easy HUD (tray icon → Quit, then open it again).',
      });
    } else if (this.estadoGep === 'esperando' && desdeInicio >= 60_000) {
      alertas.push({
        id: 'gep-esperando',
        nivel: 'aviso',
        titulo: 'Overwolf game events not ready yet',
        detalle: 'Still waiting for Overwolf. If this does not clear in a minute, restart Easy HUD.',
      });
    }

    if (this.estadoGep === 'listo' && this.abierto && !this.detectado && this.abiertoDesde !== null && t - this.abiertoDesde >= 30_000) {
      alertas.push({
        id: 'juego-no-detectado',
        nivel: 'error',
        titulo: 'VALORANT is open but Easy HUD cannot see it',
        detalle: 'Close VALORANT and Easy HUD, then open Easy HUD first and VALORANT after. Make sure neither runs as administrator.',
      });
    }

    if (this.estadoGep === 'listo' && this.detectado && this.ultimoEvento === null && this.detectadoDesde !== null && t - this.detectadoDesde >= 60_000) {
      alertas.push({
        id: 'sin-eventos',
        nivel: 'error',
        titulo: 'No game data is arriving',
        detalle: 'Overwolf sees VALORANT but sends no events. Restart Easy HUD with VALORANT already open.',
      });
    }

    if (this.conflictos.length > 0) {
      alertas.push({
        id: 'conflicto',
        nivel: 'error',
        titulo: 'Another program is competing for the game data',
        detalle: `${this.conflictos.join(', ')} is also running. Two programs split Overwolf's game data, so each gets only part of it (no health or abilities). Close it (Task Manager) and restart Easy HUD.`,
      });
    }

    if (this.esEspectador && this.estadoDatos === 'conectada') {
      alertas.push({
        id: 'espectador',
        nivel: 'error',
        titulo: 'Easy HUD thinks you are a spectator',
        detalle: 'So it is sending no health or abilities. Close VALORANT and Easy HUD, open Easy HUD first, then VALORANT.',
      });
    }

    if (!this.tieneRiotId && desdeInicio >= 90_000) {
      alertas.push({
        id: 'riot',
        nivel: 'aviso',
        titulo: 'Riot Client not detected',
        detalle: 'Log in to the Riot Client so the operator can find you and add you to the lobby.',
      });
    }

    if (this.cam.error !== '') {
      alertas.push({ id: 'camara', nivel: 'aviso', titulo: 'Camera problem', detalle: this.cam.error });
    }

    // Lo que sólo ven las comprobaciones de arranque (orden de apertura, permisos, versión, eventos de
    // Overwolf, carpeta temporal). El resto ya tiene su alerta propia arriba y no se duplica.
    for (const c of this.comprobaciones) {
      if (!ALERTAS_DE_ARRANQUE.has(c.id) || (c.nivel !== 'aviso' && c.nivel !== 'error')) continue;
      alertas.push({ id: `arranque-${c.id}`, nivel: c.nivel === 'error' ? 'error' : 'aviso', titulo: c.titulo, detalle: `${c.detalle} ${c.arreglo}` });
    }

    return alertas.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'error' ? -1 : 1));
  }

  /** Texto plano para pegar en un mensaje al operador (menú «Copy diagnostics»). */
  texto(red: EstadoRed): string {
    const i = this.instantanea();
    const seg = (ms: number | null) => (ms === null ? 'never' : `${Math.round(ms / 1000)} s ago`);
    const lineas = [
      `Easy HUD ${i.version}`,
      `Server connection: ${red.conectada ? 'connected' : 'NOT connected'} for ${Math.round(red.desdeMs / 1000)} s` +
        `${red.oidoPorServidor ? ', server answers' : ''}${red.ultimoFallo !== '' ? ` (last failure: ${red.ultimoFallo})` : ''}, attempts: ${red.intentos}`,
      `Match connection: ${i.datos}`,
      `Overwolf GEP: ${i.gep}${i.gepVersion !== '' ? ` ${i.gepVersion}` : ''}`,
      `VALORANT: ${i.juegoAbierto ? 'open' : 'not open'}, ${i.juegoDetectado ? 'detected by Overwolf' : 'not detected by Overwolf'}`,
      `Last game event: ${seg(i.eventosHace)}`,
      ...(i.conflictos.length > 0 ? [`CONFLICT — other programs using Overwolf: ${i.conflictos.join(', ')}`] : []),
      `Riot Client: ${i.riot !== '' ? i.riot : 'unknown'}`,
      `Camera: ${i.camara.permitida ? 'on' : 'off'}${i.camara.publicando ? ', streaming' : ''}${i.camara.error !== '' ? `, error: ${i.camara.error}` : ''}`,
      `Packets sent: ${Object.entries(i.enviados).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
    ];
    if (i.errores.length > 0) lineas.push('Recent errors:', ...i.errores.map((e) => `  - ${e}`));
    const alertas = this.alertas(red);
    if (alertas.length > 0) lineas.push('Problems:', ...alertas.map((a) => `  - [${a.nivel}] ${a.titulo}: ${a.detalle}`));
    return lineas.join('\n');
  }
}
