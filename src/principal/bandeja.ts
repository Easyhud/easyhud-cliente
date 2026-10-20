/**
 * El icono de la bandeja.
 *
 * Crear la bandeja nunca puede tumbar la carga de la ventana: si falla, se
 * registra y se sigue sin ella. En Linux no se crea.
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { error, log } from './registro.ts';

export class Bandeja {
  private tray: Tray | null = null;
  private readonly icono: string | null;
  private readonly abre: () => void;
  private readonly sale: () => void;
  private readonly extras: () => MenuItemConstructorOptions[];

  constructor(icono: string | null, abre: () => void, sale: () => void, extras: () => MenuItemConstructorOptions[] = () => []) {
    this.extras = extras;
    this.icono = icono;
    this.abre = abre;
    this.sale = sale;
  }

  get existe(): boolean {
    return this.tray !== null;
  }

  asegura(): void {
    if (this.tray !== null || process.platform === 'linux') return;
    try {
      const imagen = this.icono !== null ? nativeImage.createFromPath(this.icono) : nativeImage.createEmpty();
      if (this.icono === null) log('bandeja: sin icono empaquetado, se usa uno vacío');
      const t = new Tray(imagen);
      t.setToolTip('Easy HUD');
      t.setContextMenu(this.menu());
      t.on('click', () => this.abre());
      this.tray = t;
    } catch (e) {
      error('no se pudo crear la bandeja; se sigue sin ella', e);
    }
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: 'Open Easy HUD', click: () => this.abre() },
      ...this.extras(),
      { label: 'Quit Easy HUD (close completely)', click: () => this.sale() },
    ]);
  }

  /** El texto al pasar el ratón por el icono (aquí se ve de un vistazo si algo falla). */
  fijaTooltip(texto: string): void {
    this.tray?.setToolTip(texto.slice(0, 120));
  }

  /** Rehace el menú (cambió algo que muestra, p. ej. la casilla de la cámara). */
  actualizaMenu(): void {
    this.tray?.setContextMenu(this.menu());
  }

  quita(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
