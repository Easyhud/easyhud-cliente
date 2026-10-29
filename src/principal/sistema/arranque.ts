/**
 * Comprobaciones de arranque («a prueba de errores de operador y de jugador»).
 *
 * Reúne en una sola lista, con el mismo formato, todo lo que tiene que estar bien para que el directo
 * funcione y que el operador o el jugador pueden arreglar con sus manos: el Riot Client, VALORANT y el
 * ORDEN de apertura, Overwolf GEP, el servidor, otros programas que compiten por Overwolf, el nivel de
 * permisos (administrador) y la versión del programa frente a la del servidor.
 *
 * Cada resultado dice QUÉ pasa y QUÉ HACER, en inglés como el resto de textos del programa. No duplica
 * lo que ya existe: la información sale de `diagnostico/`, `sistema/conflictos.ts`, `sistema/entorno.ts` y
 * `diagnostico/autoprueba.ts`; esto sólo las junta y las traduce a una lista accionable.
 *
 * Todo lo que decide es puro (`evaluaArranque`) y se prueba sin Electron; `ComprobadorArranque` sólo
 * recoge los datos con funciones inyectadas.
 */

import { leeSemver } from './actualizaciones.ts';
import type { Entorno } from './entorno.ts';

export type NivelComprobacion = 'ok' | 'info' | 'aviso' | 'error';

export interface Comprobacion {
  /** Estable: sirve para no repetir avisos y para enlazar con las alertas del jugador. */
  id: 'riot' | 'valorant' | 'orden' | 'gep' | 'eventos' | 'servidor' | 'version' | 'conflicto' | 'admin' | 'temporal';
  titulo: string;
  nivel: NivelComprobacion;
  /** Qué pasa. */
  detalle: string;
  /** Qué hacer (vacío si todo va bien). */
  arreglo: string;
}

export type EstadoRiotLocal = 'ok' | 'sin-sesion' | 'cerrado';

export interface EntradaArranque {
  rol: 'observador' | 'jugador';
  /** La versión de este programa. */
  version: string;
  /** El cliente de Riot local (`null` = no se pudo mirar). */
  riot: EstadoRiotLocal | null;
  valorant: {
    abierto: boolean | null;
    /** VALORANT ya estaba abierto cuando arrancó Easy HUD (`null` = no se sabe). */
    yaAbiertoAlArrancar: boolean | null;
    /** Overwolf lo ha detectado. */
    detectado: boolean;
  };
  gep: 'esperando' | 'listo' | 'caido' | 'sin-api';
  gepVersion: string;
  /** Estado de los eventos de Overwolf para VALORANT: 1 verde, 2 amarillo, 3 rojo, 4 desactivados; `null` = bien o sin dato. */
  eventosOverwolf: number | null;
  /** `null` = aún sin probar. */
  servidor: { ok: boolean; causa: string; arreglo: string; version: string } | null;
  conflictos: string[];
  /** Procesos del Overwolf de escritorio abiertos. */
  overwolfEscritorio: number;
  /** El entorno del PC (`null` = no se pudo leer). */
  entorno: Pick<Entorno, 'esAdmin' | 'valorantElevado' | 'desdeTemporal'> | null;
  /** GEP dijo que VALORANT corre con más privilegios que este programa. */
  privilegiosRequeridos: boolean;
}

/** Misma línea (`major.minor`): lo que acepta el servidor es siempre una franja dentro de la línea actual. */
export function versionCompatible(cliente: string, servidor: string): boolean | null {
  const c = leeSemver(cliente);
  const s = leeSemver(servidor);
  if (c === null || s === null) return null;
  return c[0] === s[0] && c[1] === s[1];
}

const OK = (id: Comprobacion['id'], titulo: string, detalle: string): Comprobacion => ({ id, titulo, nivel: 'ok', detalle, arreglo: '' });

/** Todas las comprobaciones que se pueden evaluar con lo que hay; las que aún no tienen dato se omiten. */
export function evaluaArranque(e: EntradaArranque): Comprobacion[] {
  const lista: Comprobacion[] = [];
  const esJugador = e.rol === 'jugador';

  /* Riot Client. */
  if (e.riot !== null) {
    if (e.riot === 'ok') lista.push(OK('riot', 'Riot Client', 'Riot Client is open and you are signed in.'));
    else {
      const sinSesion = e.riot === 'sin-sesion';
      lista.push({
        id: 'riot',
        titulo: sinSesion ? 'Riot Client: not signed in' : 'Riot Client is not open',
        nivel: esJugador ? 'aviso' : 'info',
        detalle: sinSesion ? 'The Riot Client is open but there is no signed-in account.' : 'The Riot Client is not running.',
        arreglo: esJugador
          ? 'Open the Riot Client and sign in with your VALORANT account, so the organizer can find you and add you to the lobby.'
          : 'Open the Riot Client and sign in. It is only needed for reading or creating the lobby from the panel.',
      });
    }
  }

  /* VALORANT y el orden de apertura. */
  if (e.valorant.abierto !== null) {
    if (!e.valorant.abierto) {
      lista.push({
        id: 'valorant',
        titulo: 'VALORANT is not open yet',
        nivel: 'info',
        detalle: 'VALORANT is not running.',
        arreglo: 'Open VALORANT now (after Easy HUD, never before).',
      });
    } else if (e.valorant.detectado) {
      lista.push(OK('valorant', 'VALORANT', 'VALORANT is open and Overwolf can see it.'));
    } else if (e.valorant.yaAbiertoAlArrancar === true && e.gep === 'listo') {
      lista.push({
        id: 'orden',
        titulo: 'VALORANT was opened before Easy HUD',
        nivel: 'aviso',
        detalle: 'VALORANT was already running when Easy HUD started and Overwolf has not detected it. Game data may never arrive.',
        arreglo: 'Close VALORANT, make sure Easy HUD is open, then open VALORANT again. Always open Easy HUD first and VALORANT second.',
      });
    } else {
      lista.push({
        id: 'valorant',
        titulo: 'VALORANT is open but not detected yet',
        nivel: 'info',
        detalle: 'Overwolf has not reported VALORANT yet.',
        arreglo: e.gep === 'listo' ? 'Wait a few seconds. If it does not clear, close VALORANT and open it again.' : 'Wait for Overwolf to finish starting.',
      });
    }
  }

  /* Overwolf GEP. */
  if (e.gep === 'listo') lista.push(OK('gep', 'Overwolf game events', `Overwolf GEP is ready${e.gepVersion !== '' ? ` (${e.gepVersion})` : ''}.`));
  else if (e.gep === 'esperando') {
    lista.push({
      id: 'gep',
      titulo: 'Overwolf game events are still starting',
      nivel: 'info',
      detalle: 'Overwolf has not finished starting its game-events package.',
      arreglo: 'Wait a moment. If it does not say Ready within a minute, restart Easy HUD.',
    });
  } else {
    lista.push({
      id: 'gep',
      titulo: 'Overwolf game events failed',
      nivel: 'error',
      detalle: e.gep === 'sin-api' ? 'This build was not started through Overwolf, so it cannot read VALORANT.' : 'The Overwolf package that reads VALORANT crashed.',
      arreglo: 'Close Easy HUD completely (tray icon → Quit) and open it again with the shortcut the installer created.',
    });
  }
  if (e.eventosOverwolf !== null && e.eventosOverwolf >= 2) {
    const nombre = ['', 'green', 'yellow', 'red', 'disabled'][e.eventosOverwolf] ?? String(e.eventosOverwolf);
    lista.push({
      id: 'eventos',
      titulo: `Overwolf reports VALORANT events as ${nombre}`,
      nivel: e.eventosOverwolf >= 3 ? 'error' : 'aviso',
      detalle: 'The game-events service of Overwolf is degraded for VALORANT right now. This is on their side, not on this PC.',
      arreglo: 'Nothing to fix here: some data (or all of it) may be missing until Overwolf recovers. Tell the organizer.',
    });
  }

  /* Servidor y versión. */
  if (e.servidor !== null) {
    if (e.servidor.ok) {
      lista.push(OK('servidor', 'Easy HUD server', 'The Easy HUD server is reachable.'));
      if (e.servidor.version !== '') {
        const compatible = versionCompatible(e.version, e.servidor.version);
        if (compatible === false) {
          lista.push({
            id: 'version',
            titulo: 'This Easy HUD version does not match the server',
            nivel: 'error',
            detalle: `Easy HUD ${e.version} is not compatible with the server (${e.servidor.version}). The server will reject the connection.`,
            arreglo: 'Install the latest Easy HUD version from the organizer, then open it again.',
          });
        } else if (compatible === true) {
          lista.push(OK('version', 'Version', `Easy HUD ${e.version} works with this server (${e.servidor.version}).`));
        }
      }
    } else {
      lista.push({
        id: 'servidor',
        titulo: 'Cannot reach the Easy HUD server',
        nivel: 'error',
        detalle: e.servidor.causa !== '' ? e.servidor.causa : 'The server did not answer.',
        arreglo: e.servidor.arreglo !== '' ? e.servidor.arreglo : 'Check your internet connection, VPN or firewall. Easy HUD keeps trying by itself.',
      });
    }
  }

  /* Otros programas que compiten por Overwolf. */
  if (e.conflictos.length > 0) {
    lista.push({
      id: 'conflicto',
      titulo: 'Another program is competing for the game data',
      nivel: 'error',
      detalle: `${e.conflictos.join(', ')} is also running. Two programs split Overwolf's data, so each one gets only part of it.`,
      arreglo: 'Close it from the Task Manager (all other Easy HUD, ValoSpectra and Overwolf windows), then restart Easy HUD.',
    });
  } else if (e.overwolfEscritorio > 0) {
    lista.push({
      id: 'conflicto',
      titulo: 'The regular Overwolf app is running',
      nivel: 'aviso',
      detalle: 'The desktop Overwolf app shares the same game-events service and can make data fail.',
      arreglo: 'Quit Overwolf (right-click its tray icon → Exit Overwolf) and restart Easy HUD.',
    });
  } else {
    lista.push(OK('conflicto', 'Other programs', 'No other program is competing for Overwolf.'));
  }

  /* Mismo nivel de permisos que VALORANT. */
  const noPuedeLeer = e.privilegiosRequeridos || (e.entorno?.valorantElevado === true && e.entorno.esAdmin === false);
  if (noPuedeLeer) {
    lista.push({
      id: 'admin',
      titulo: 'VALORANT runs as administrator but Easy HUD does not',
      nivel: 'error',
      detalle: 'Overwolf cannot read a game that has more privileges than the program asking for the data. No game data will arrive.',
      arreglo:
        'Close both. Then either stop running VALORANT as administrator (Riot Client / VALORANT shortcut → Properties → Compatibility → untick "Run as administrator"), ' +
        'or run Easy HUD as administrator (the player program asks for it by itself when it opens: accept the Windows prompt; otherwise right-click → Run as administrator). Open Easy HUD first, VALORANT second.',
    });
  } else if (e.entorno !== null && e.entorno.esAdmin !== null) {
    lista.push(OK('admin', 'Permissions', 'Easy HUD and VALORANT run with compatible permissions.'));
  }
  if (e.entorno?.desdeTemporal === true) {
    lista.push({
      id: 'temporal',
      titulo: 'Easy HUD is running from a temporary folder',
      nivel: 'aviso',
      detalle: 'It was launched from a temporary location (a portable copy), which breaks Overwolf and the startup shortcuts.',
      arreglo: 'Install Easy HUD with its installer and open it from the Start menu shortcut.',
    });
  }

  return lista;
}

const PESO: Record<NivelComprobacion, number> = { ok: 0, info: 1, aviso: 2, error: 3 };

/** El peor nivel de la lista. */
export function peorNivel(lista: readonly Comprobacion[]): NivelComprobacion {
  return lista.reduce<NivelComprobacion>((peor, c) => (PESO[c.nivel] > PESO[peor] ? c.nivel : peor), 'ok');
}

/** Lo que hay que enseñar como problema (avisos y errores; `info` sólo es una pista). */
export function problemas(lista: readonly Comprobacion[]): Comprobacion[] {
  return lista.filter((c) => c.nivel === 'aviso' || c.nivel === 'error').sort((a, b) => PESO[b.nivel] - PESO[a.nivel]);
}

/** Texto plano para el diálogo, el log o pegar en un mensaje. */
export function textoComprobaciones(lista: readonly Comprobacion[], soloProblemas = false): string {
  const marca: Record<NivelComprobacion, string> = { ok: 'OK   ', info: 'INFO ', aviso: 'WARN ', error: 'FAIL ' };
  const origen = soloProblemas ? problemas(lista) : lista;
  return origen
    .map((c) => `${marca[c.nivel]}${c.titulo}${c.nivel === 'ok' ? '' : `\n      ${c.detalle}\n      → ${c.arreglo}`}`)
    .join('\n');
}

/* ── Recogida de datos ─────────────────────────────────────────────────── */

export interface DepsArranque {
  rol: 'observador' | 'jugador';
  version: string;
  riot(): Promise<EstadoRiotLocal>;
  valorantAbierto(): Promise<boolean>;
  entorno(): Promise<EntradaArranque['entorno']>;
  conflictos(): Promise<{ conflictos: string[]; overwolfEscritorio: number }>;
  servidor(): Promise<EntradaArranque['servidor']>;
  /** Estado de GEP ahora. */
  gep(): { estado: EntradaArranque['gep']; version: string; detectado: boolean };
  eventosOverwolf(): number | null;
  privilegiosRequeridos(): boolean;
}

/** Junta los datos con las funciones inyectadas y evalúa. Cada fuente que falla simplemente no aporta. */
export class ComprobadorArranque {
  private yaAbiertoAlArrancar: boolean | null = null;
  private readonly deps: DepsArranque;
  private enCurso: Promise<Comprobacion[]> | null = null;

  constructor(deps: DepsArranque) {
    this.deps = deps;
  }

  /** Lo que valía al arrancar: se fija con la primera lectura de VALORANT (la del arranque). */
  async ejecuta(): Promise<Comprobacion[]> {
    // Dos peticiones a la vez (botón y reloj) comparten la misma pasada.
    this.enCurso ??= this.pasada().finally(() => {
      this.enCurso = null;
    });
    return this.enCurso;
  }

  private async pasada(): Promise<Comprobacion[]> {
    const d = this.deps;
    const seguro = async <T>(f: () => Promise<T>, defecto: T): Promise<T> => {
      try {
        return await f();
      } catch {
        return defecto;
      }
    };
    const [riot, abierto, entorno, otros, servidor] = await Promise.all([
      seguro<EstadoRiotLocal | null>(() => d.riot(), null),
      seguro<boolean | null>(() => d.valorantAbierto(), null),
      seguro(() => d.entorno(), null),
      seguro(() => d.conflictos(), { conflictos: [] as string[], overwolfEscritorio: 0 }),
      seguro(() => d.servidor(), null),
    ]);
    // La primera lectura fija «ya estaba abierto al arrancar». Si luego se ve cerrado, el jugador lo cerró y lo abrió
    // de nuevo DESPUÉS de Easy HUD (que es lo correcto): deja de contar.
    if (this.yaAbiertoAlArrancar === null && abierto !== null) this.yaAbiertoAlArrancar = abierto;
    else if (abierto === false) this.yaAbiertoAlArrancar = false;
    const g = d.gep();
    return evaluaArranque({
      rol: d.rol,
      version: d.version,
      riot,
      valorant: { abierto, yaAbiertoAlArrancar: this.yaAbiertoAlArrancar, detectado: g.detectado },
      gep: g.estado,
      gepVersion: g.version,
      eventosOverwolf: d.eventosOverwolf(),
      servidor,
      conflictos: otros.conflictos,
      overwolfEscritorio: otros.overwolfEscritorio,
      entorno,
      privilegiosRequeridos: d.privilegiosRequeridos(),
    });
  }
}
