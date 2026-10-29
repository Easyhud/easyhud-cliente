/**
 * El puente de la ventana del jugador: el botón de la cámara y el estado del programa.
 *
 * Corre en el preload, aislado: no puede importar módulos propios, por eso los
 * nombres de canal se repiten aquí (deben coincidir con `camara/ipc.ts`).
 */

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('camaraAPI', {
  estado: () => ipcRenderer.invoke('camara-estado'),
  alterna: () => ipcRenderer.invoke('camara-alterna'),
  dispositivo: () => ipcRenderer.invoke('camara-dispositivo'),
  fijaDispositivo: (etiqueta: string) => ipcRenderer.invoke('camara-fija-dispositivo', etiqueta),
});

contextBridge.exposeInMainWorld('jugadorAPI', {
  estado: () => ipcRenderer.invoke('jugador-estado'),
  copiaDiagnostico: () => ipcRenderer.invoke('jugador-copia-diagnostico'),
  abreLogs: () => ipcRenderer.invoke('jugador-abre-logs'),
  pruebaRed: () => ipcRenderer.invoke('jugador-prueba-red'),
  salir: () => ipcRenderer.invoke('jugador-salir'),
  enviaInforme: () => ipcRenderer.invoke('jugador-informe-enviar'),
  guardaInforme: () => ipcRenderer.invoke('jugador-informe-guardar'),
  permiteFirewall: () => ipcRenderer.invoke('jugador-firewall'),
  ajustesCamara: () => ipcRenderer.invoke('jugador-ajustes-camara'),
  reconectaTodo: () => ipcRenderer.invoke('jugador-reconecta'),
  comprobaciones: () => ipcRenderer.invoke('jugador-comprobaciones'),
});
