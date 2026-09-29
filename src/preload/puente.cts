/**
 * El puente que ve el panel: `window.electronAPI`.
 *
 * Corre en el preload, aislado (contextIsolation + sandbox): no puede importar
 * módulos propios, por eso los nombres de canal se repiten aquí. La prueba
 * `test/ipc.test.ts` carga este fichero con un `electron` falso y comprueba
 * cada método contra `src/principal/canales.ts`.
 *
 * Cada método es un canal concreto; no hay canal genérico, así la página no
 * puede pedir al programa nada que no esté en esta lista.
 */

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

type Callback<T> = (dato: T) => void;

/** Suscripción a un canal programa → página. Devuelve cómo darse de baja. */
function suscribe<T>(canal: string, cb: Callback<T>, transforma: (d: unknown) => T = (d) => d as T): () => void {
  const oyente = (_e: unknown, d: unknown) => cb(transforma(d));
  ipcRenderer.on(canal, oyente);
  return () => ipcRenderer.removeListener(canal, oyente);
}

function db(col: 'teams' | 'matches' | 'tournaments') {
  return {
    list: () => ipcRenderer.invoke(`db:${col}:list`),
    create: (dato: unknown) => ipcRenderer.invoke(`db:${col}:create`, dato),
    update: (id: unknown, parche: unknown) => ipcRenderer.invoke(`db:${col}:update`, id, parche),
    remove: (id: unknown) => ipcRenderer.invoke(`db:${col}:delete`, id),
  };
}

const equipos = db('teams');
const matches = db('matches');
const torneos = db('tournaments');

contextBridge.exposeInMainWorld('electronAPI', {
  getBuildProfile: () => ipcRenderer.sendSync('get-build-profile'),
  getObsUrl: () => ipcRenderer.sendSync('get-obs-url'),

  conecta: (token: string, grupo: string) => ipcRenderer.send('conecta', token, grupo),
  arrancaOverlayLocal: (token: string, grupo: string) => ipcRenderer.send('arranca-overlay-local', token, grupo),
  paraOverlayLocal: () => ipcRenderer.send('para-overlay-local'),
  arrancaLectorSala: () => ipcRenderer.send('arranca-lector-sala'),
  paraLectorSala: () => ipcRenderer.send('para-lector-sala'),

  onSalaLocal: (cb: Callback<unknown>) => suscribe('sala-local', cb),
  onEscena: (cb: Callback<string>) =>
    suscribe('set-game-status', cb, (d) => {
      const m = typeof d === 'object' && d !== null ? (d as { message?: unknown }).message : undefined;
      return typeof m === 'string' ? m : '';
    }),
  onSerieFin: (cb: Callback<unknown>) => suscribe('serie-mapa-fin', cb),

  creaSalaTorneo: () => ipcRenderer.invoke('crea-sala'),
  llamaJugadores: (puuids: unknown) => ipcRenderer.invoke('llamar-jugadores', puuids ?? []),

  dbTeamsList: equipos.list,
  dbTeamsCreate: equipos.create,
  dbTeamsUpdate: equipos.update,
  dbTeamsDelete: equipos.remove,
  dbMatchesList: matches.list,
  dbMatchesCreate: matches.create,
  dbMatchesUpdate: matches.update,
  dbMatchesDelete: matches.remove,
  dbTournamentsList: torneos.list,
  dbTournamentsCreate: torneos.create,
  dbTournamentsUpdate: torneos.update,
  dbTournamentsDelete: torneos.remove,

  aplicaAtajos: (atajos: unknown) => ipcRenderer.send('aplica-atajos', atajos),
  suspendeAtajos: () => ipcRenderer.send('suspende-atajos'),
  operadorOverlay: (mostrar: boolean) => ipcRenderer.send('operador-overlay', mostrar === true),

  ventanaMinimizar: () => ipcRenderer.send('ventana-minimizar'),
  ventanaMaximizar: () => ipcRenderer.send('ventana-maximizar'),
  ventanaCerrar: () => ipcRenderer.send('ventana-cerrar'),

  openExternalLink: (url: string) => ipcRenderer.send('open-external-link', url),
});
