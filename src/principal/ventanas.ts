/**
 * Las ventanas.
 *
 *   · principal del observador: sin marco (la barra la dibuja el panel), carga
 *     el panel desde disco, recuerda su tamaño;
 *   · del jugador: una página estática que casi nunca se ve (arranca oculto);
 *   · operador: transparente encima del juego, que OBS no captura.
 *
 * Todas: no se abren ventanas nuevas (las https van al navegador), no se
 * navega fuera del documento y no se adjuntan webviews.
 */

import { BrowserWindow, screen, shell, type WebContents } from 'electron';
import type { Almacen, FormaClaves } from './almacen.ts';
import { PAGINA_JUGADOR, PANEL, PRELOAD } from './rutas.ts';

const FONDO = '#08080a';

/** Las tres reglas de contención, para cualquier contenido web. */
export function blindaContenido(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e, preferencias) => {
    delete preferencias.preload;
    preferencias.nodeIntegration = false;
    e.preventDefault();
  });
}

const limita = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Rectángulo restaurado de `windowState`, con el ancho y alto acotados. */
export function rectanguloGuardado(estado: FormaClaves['windowState']) {
  const b = estado.bounds;
  if (!b || [b.x, b.y, b.width, b.height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return { x: b.x, y: b.y, width: limita(b.width, 750, 1920), height: limita(b.height, 650, 1080) };
}

export function creaVentanaObservador(almacen: Almacen, desarrollo: boolean): BrowserWindow {
  const guardado = rectanguloGuardado(almacen.lee('windowState'));
  const v = new BrowserWindow({
    ...(guardado ?? { width: 1300, height: 670, center: true }),
    minWidth: 830,
    minHeight: 650,
    frame: false,
    backgroundColor: FONDO,
    title: 'Easy HUD',
    fullscreenable: false,
    resizable: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: desarrollo,
    },
  });
  blindaContenido(v.webContents);
  // El título lo pone el programa ("Easy HUD | <estado>"), no el documento.
  v.on('page-title-updated', (e) => e.preventDefault());

  const guarda = () => {
    if (v.isDestroyed()) return;
    void almacen.escribe('windowState', { bounds: v.getNormalBounds() }).catch(() => undefined);
  };
  for (const evento of ['resized', 'moved', 'maximize', 'unmaximize'] as const) v.on(evento as 'resize', guarda);

  void v.loadFile(PANEL);
  return v;
}

export function creaVentanaJugador(): BrowserWindow {
  // Antes: alto 460 con máximo 320. Se unifica a 750×320.
  const v = new BrowserWindow({
    x: 0,
    y: 0,
    width: 750,
    height: 320,
    minWidth: 750,
    minHeight: 320,
    maxWidth: 750,
    maxHeight: 320,
    resizable: false,
    backgroundColor: FONDO,
    title: 'Easy HUD',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
  });
  blindaContenido(v.webContents);
  v.on('page-title-updated', (e) => e.preventDefault());
  void v.loadFile(PAGINA_JUGADOR);
  return v;
}

/** La ventana operador: se crea la primera vez y se reutiliza. */
export class VentanaOperador {
  private ventana: BrowserWindow | null = null;
  private readonly url: () => string;

  constructor(url: () => string) {
    this.url = url;
  }

  private crea(): BrowserWindow {
    const { bounds } = screen.getPrimaryDisplay();
    const v = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
    });
    v.setAlwaysOnTop(true, 'screen-saver');
    v.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Windows la excluye de las capturas: OBS no la ve.
    v.setContentProtection(true);
    v.setIgnoreMouseEvents(true, { forward: true });
    blindaContenido(v.webContents);
    v.on('closed', () => {
      this.ventana = null;
    });
    void v.loadURL(this.url());
    return v;
  }

  muestra(si: boolean): void {
    if (!si) {
      this.ventana?.hide();
      return;
    }
    if (this.ventana === null || this.ventana.isDestroyed()) this.ventana = this.crea();
    this.ventana.showInactive();
  }

  alterna(): void {
    this.muestra(!(this.ventana?.isVisible() ?? false));
  }

  destruye(): void {
    this.ventana?.destroy();
    this.ventana = null;
  }
}
