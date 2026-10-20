/**
 * El puente de la ventana oculta del detector de pausa (sólo observador).
 * Corre en el preload, aislado: los nombres de canal se repiten aquí (deben coincidir con `sistema/captura-flujo.ts`).
 */

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('capturaAPI', {
  alArrancar: (cb: (id: string) => void) => ipcRenderer.on('captura-arranca', (_e, id: unknown) => typeof id === 'string' && cb(id)),
  alParar: (cb: () => void) => ipcRenderer.on('captura-para', () => cb()),
  muestra: (m: { color: number; brillo: number; quietoMs: number }) => ipcRenderer.send('captura-muestra', m),
  fallo: (texto: string) => ipcRenderer.send('captura-fallo', String(texto)),
});
