/**
 * Lo que decide el traductor de GEP, sin hacerlo.
 *
 * Los traductores (observador y jugador) son puros: reciben un dato de GEP y
 * devuelven una lista de acciones. Quien las ejecuta (el modo observador o el
 * modo jugador) es el único que toca sockets, ventanas o disco. Así la lógica
 * del juego se prueba con `node --test` sin Electron ni VALORANT.
 */

export type ClaseEstado = 'info' | 'danger' | 'warn' | 'success';

/** Datos del evento IPC `serie-mapa-fin` (especificación §2.5). */
export interface FinDeMapa {
  ganador: 0 | 1;
  izq: number;
  der: number;
  map: string;
  matchId: string;
  roster: Array<{
    name: string;
    tagline: string | undefined;
    team: 0 | 1;
    agentInternal: unknown;
    kills: unknown;
    deaths: unknown;
    assists: unknown;
  }>;
}

export type Accion =
  /** Enviar al servidor (`obs_data` o `aux_data` según el modo). */
  | { tipo: 'envia'; type: string; data: unknown; reintentoMs?: number }
  /** Estado de juego para el panel (`set-game-status`). */
  | { tipo: 'estadoJuego'; mensaje: string; clase: ClaseEstado }
  /** Fase de ronda (la usa la tecla de spike). */
  | { tipo: 'fase'; fase: string }
  /** Fin de mapa detectado: al panel. */
  | { tipo: 'finMapa'; datos: FinDeMapa }
  /** Cerrar la conexión con el servidor (fin de partida). */
  | { tipo: 'finConexion' }
  /** Disparo de conexión automática (§3.1.3). */
  | { tipo: 'conecta'; retardoMs?: number }
  /** Re-persistir el secreto de reconexión (observador, `match_start`). */
  | { tipo: 'persisteSecreto' }
  /** Persistir el puuid del jugador. */
  | { tipo: 'persistePuuid'; puuid: string }
  /** Resolver el rango de un roster en segundo plano y reenviarlo si cambia. */
  | { tipo: 'resuelveRango'; roster: { playerId: unknown; rank: unknown } & Record<string, unknown> }
  | { tipo: 'log'; texto: string };

export interface DatoGep {
  key: string;
  value: unknown;
}
