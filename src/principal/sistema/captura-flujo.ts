/**
 * Flujo de vídeo de la pantalla para el detector de pausa (sólo en el observador).
 *
 * Pedir capturas sueltas (`desktopCapturer.getSources`) cuesta ~300 ms y casi un núcleo entero cada vez, sea cual
 * sea el tamaño de la miniatura. Un flujo de vídeo (`getUserMedia` con `chromeMediaSource: 'desktop'`) en una
 * ventana oculta da 10 muestras por segundo por ~10 % de un núcleo. La página (`recursos/captura.html`) reduce cada
 * fotograma a 96×54 y sólo manda dos números: fracción de píxeles con color y brillo medio.
 *
 * Por defecto mira la pantalla principal; `EASY_PANTALLA_JUEGO=1` (0 = la primera, 1 = la segunda…) si el juego está en otra.
 */

import { app, BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import { PAGINA_CAPTURA, PRELOAD_CAPTURA } from '../rutas.ts';
import { blindaContenido } from '../ventanas.ts';
import type { Medida } from './detector-pausa.ts';

const PANTALLA = Number.parseInt(process.env.EASY_PANTALLA_JUEGO ?? '0', 10) || 0;

const esNumero = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export class CapturaFlujo {
  private ventana: BrowserWindow | null = null;
  private activa = false;
  private readonly alMedir: (m: Medida) => void;
  private readonly log: (m: string) => void;
  private oyentesPuestos = false;

  constructor(alMedir: (m: Medida) => void, log: (m: string) => void) {
    this.alMedir = alMedir;
    this.log = log;
  }

  private asegura(): BrowserWindow {
    if (this.ventana !== null && !this.ventana.isDestroyed()) return this.ventana;
    const v = new BrowserWindow({
      show: false,
      width: 120,
      height: 80,
      webPreferences: { preload: PRELOAD_CAPTURA, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false, backgroundThrottling: false },
    });
    blindaContenido(v.webContents);
    v.on('closed', () => {
      this.ventana = null;
    });
    void v.loadFile(PAGINA_CAPTURA);
    this.ventana = v;
    if (!this.oyentesPuestos) {
      this.oyentesPuestos = true;
      ipcMain.on('captura-muestra', (e, m: unknown) => {
        if (this.ventana === null || e.sender !== this.ventana.webContents) return;
        const d = m as { color?: unknown; brillo?: unknown; quietoMs?: unknown } | null;
        if (d !== null && esNumero(d.color) && esNumero(d.brillo)) {
          this.alMedir({ color: d.color, brillo: d.brillo, ...(esNumero(d.quietoMs) ? { quietoMs: d.quietoMs } : {}) });
        }
      });
      ipcMain.on('captura-fallo', (_e, texto: unknown) => this.log(`detector de pausa: no se pudo abrir el flujo de pantalla: ${String(texto)}`));
    }
    return v;
  }

  /** Empieza a medir (la compra ha empezado). */
  async arranca(): Promise<void> {
    if (this.activa) return;
    this.activa = true;
    try {
      await app.whenReady();
      const pantallas = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      const p = pantallas[PANTALLA] ?? pantallas[0];
      if (p === undefined) {
        this.activa = false;
        return;
      }
      const v = this.asegura();
      const manda = () => {
        if (this.activa && !v.isDestroyed()) v.webContents.send('captura-arranca', p.id);
      };
      if (v.webContents.isLoading()) v.webContents.once('did-finish-load', manda);
      else manda();
    } catch (e) {
      this.activa = false;
      this.log(`detector de pausa: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Deja de medir (ya no es la compra). */
  para(): void {
    this.activa = false;
    if (this.ventana !== null && !this.ventana.isDestroyed()) this.ventana.webContents.send('captura-para');
  }

  destruye(): void {
    this.para();
    this.ventana?.destroy();
    this.ventana = null;
  }
}
