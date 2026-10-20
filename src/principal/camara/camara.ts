/**
 * La cámara del jugador: una ventana oculta que publica su webcam en la sala
 * de vídeo con el ID `Nombre_H_TAG`, y el aviso al servidor (`aux_cam`) de que
 * está publicando.
 *
 *   servidor ──cam_config──▶ aquí ──ventana oculta──▶ web de vídeo ──▶ OBS
 *                               └────aux_cam────────▶ servidor (enabledPlayers)
 *
 * Se publica sólo si el JUGADOR la encendió (privado: apagada en cada arranque),
 * el operador activó las cámaras, hay sala, está conectado al grupo y se conoce
 * su `Nombre#TAG`. Si algo de eso falla, se cierra. El permiso de cámara se concede únicamente a la web de vídeo.
 */

import { BrowserWindow, session as sesionElectron } from 'electron';
import { log } from '../registro.ts';
import { blindaContenido } from '../ventanas.ts';
import { debePublicar, leeConfigCamara, urlPublicacion, type ConfigCamara } from './url.ts';

const LATIDO_MS = 10_000;
const GRACIA_CORTE_MS = 60_000;
const PARTICION = 'persist:easyhud-camara';

export interface OpcionesCamara {
  /** Manda `aux_cam` por el socket del jugador; `false` si no hay conexión. */
  anuncia(publicando: boolean, id: string): boolean;
  nombre(): string;
  /** Etiqueta (o parte) de la cámara a usar; vacío = la predeterminada. */
  dispositivo(): string;
  /** El jugador la encendió. Sin esto no se publica nunca, diga lo que diga el operador. */
  permitida(): boolean;
}

export interface EstadoCamara {
  /** El jugador la tiene encendida. */
  permitida: boolean;
  /** El operador activó las cámaras y hay sala. */
  operador: boolean;
  /** Se está emitiendo ahora mismo. */
  enDirecto: boolean;
  /** Último problema de la cámara (permiso, no hay cámara, la web de vídeo no cargó); vacío = ninguno. */
  error: string;
}

export class CamaraJugador {
  private config: ConfigCamara | null = null;
  private conectado = false;
  private ventana: BrowserWindow | null = null;
  private urlAbierta = '';
  private idAnunciado = '';
  private latido: NodeJS.Timeout | null = null;
  private corte: NodeJS.Timeout | null = null;
  private readonly o: OpcionesCamara;
  private error = '';

  constructor(opciones: OpcionesCamara) {
    this.o = opciones;
  }

  /** `cam_config` del servidor (al entrar y cada vez que el operador cambia algo). */
  recibeConfig(carga: unknown): void {
    this.config = leeConfigCamara(carga);
    if (this.config === null) log('cámara: cam_config no utilizable');
    this.reevalua();
  }

  /** Cambió el estado del socket de datos. */
  alCambiarConexion(autenticado: boolean): void {
    this.conectado = autenticado;
    if (autenticado) {
      if (this.corte !== null) clearTimeout(this.corte);
      this.corte = null;
      this.idAnunciado = ''; // el servidor soltó el aviso al caer el socket: se repite
    } else if (this.ventana !== null && this.corte === null) {
      // Un corte corto no tira la cámara; uno largo, sí.
      this.corte = setTimeout(() => this.cierra(), GRACIA_CORTE_MS);
      this.corte.unref();
    }
    this.reevalua();
  }

  estado(): EstadoCamara {
    return {
      permitida: this.o.permitida(),
      operador: this.config !== null && this.config.enable && this.config.room !== '',
      enDirecto: this.ventana !== null && this.idAnunciado !== '',
      error: this.error,
    };
  }

  /** Se llama cuando puede haber cambiado algo (nombre de GEP, config, conexión). */
  reevalua(): void {
    const nombre = this.o.nombre();
    if (this.config === null || !this.o.permitida() || !debePublicar(this.config, nombre)) {
      this.cierra();
      return;
    }
    // Sin conexión no se abre ni se anuncia; una ventana ya abierta aguanta el corte (ver `corte`).
    if (!this.conectado) return;
    const url = urlPublicacion(this.config, nombre, this.o.dispositivo());
    if (this.ventana === null || this.urlAbierta !== url) this.abre(url);
    this.anuncia(nombre);
  }

  private anuncia(nombre: string): void {
    if (this.idAnunciado === nombre) return;
    if (this.o.anuncia(true, nombre)) this.idAnunciado = nombre;
  }

  private abre(url: string): void {
    this.cierraVentana();
    const base = new URL(url).origin;
    const ses = sesionElectron.fromPartition(PARTICION);
    // Cámara sí, y sólo para la web de vídeo; nada más.
    ses.setPermissionRequestHandler((wc, permiso, devuelve, detalles) => {
      const origen = (() => {
        try {
          return new URL(detalles.requestingUrl).origin;
        } catch {
          return '';
        }
      })();
      devuelve(permiso === 'media' && origen === base);
    });
    ses.setPermissionCheckHandler((wc, permiso, origen) => permiso === 'media' && origen.startsWith(base));

    const v = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: false,
        backgroundThrottling: false, // oculta no debe frenar el vídeo
      },
    });
    blindaContenido(v.webContents);
    v.webContents.on('render-process-gone', (_e, d) => {
      log(`cámara: el proceso de la ventana murió (${d.reason})`);
      this.ventana = null;
      this.urlAbierta = '';
      this.reevalua();
    });
    v.on('closed', () => {
      if (this.ventana === v) this.ventana = null;
    });
    this.ventana = v;
    this.urlAbierta = url;
    this.idAnunciado = '';
    v.webContents.on('did-finish-load', () => {
      log('cámara: la web de vídeo cargó');
      this.error = '';
    });
    // La web de vídeo no cargó (sin red, caída): se cierra y se reintenta sola, sin esperar a que el jugador toque nada.
    v.webContents.on('did-fail-load', (_e, codigo, descripcion, _url, principal) => {
      if (!principal || codigo === -3 /* ERR_ABORTED: la cerramos nosotros */ || v.isDestroyed()) return;
      this.error = `the video page did not load (${descripcion})`;
      log(`cámara: ${this.error}; se reintenta`);
      const t = setTimeout(() => {
        if (this.ventana !== v) return;
        this.cierraVentana();
        this.reevalua();
      }, 8000);
      t.unref();
    });
    // El navegador de la ventana oculta dice por consola si no pudo abrir la cámara: se recoge para avisar al jugador.
    v.webContents.on('console-message', (...args: unknown[]) => {
      // Electron nuevo manda un solo objeto con `message`; el antiguo, (evento, nivel, mensaje…).
      const primero = args[0] as { message?: unknown } | undefined;
      const mensaje = typeof primero?.message === 'string' ? primero.message : args[2];
      const m = /(NotAllowedError|NotFoundError|NotReadableError|OverconstrainedError|Permission denied)/.exec(String(mensaje));
      if (m === null) return;
      this.error = m[1] === 'NotFoundError' ? 'no camera found' : m[1] === 'NotReadableError' ? 'the camera is in use by another program' : 'the camera could not be opened (check Windows camera permission)';
    });
    void v.loadURL(url).catch((e: unknown) => {
      // Apagarla mientras carga destruye la ventana y la carga "falla": no es un fallo real.
      if (!v.isDestroyed()) log(`cámara: no se pudo cargar la web de vídeo: ${String(e)}`);
    });
    log(`cámara: publicando en la sala ${this.config?.room ?? ''} como ${this.o.nombre()}`);
    this.latido ??= setInterval(() => {
      this.idAnunciado = ''; // reafirma ante el servidor (es idempotente)
      this.reevalua();
    }, LATIDO_MS);
    this.latido.unref();
  }

  private cierraVentana(): void {
    const v = this.ventana;
    this.ventana = null;
    this.urlAbierta = '';
    if (v !== null && !v.isDestroyed()) v.destroy();
  }

  /** Deja de publicar y avisa. */
  cierra(): void {
    this.error = '';
    const habia = this.ventana !== null || this.idAnunciado !== '';
    this.cierraVentana();
    if (this.latido !== null) clearInterval(this.latido);
    this.latido = null;
    if (this.corte !== null) clearTimeout(this.corte);
    this.corte = null;
    if (habia) this.o.anuncia(false, '');
    this.idAnunciado = '';
  }
}
