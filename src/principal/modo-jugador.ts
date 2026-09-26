/**
 * El modo jugador ("auxiliar"): vive en la bandeja y manda lo que sólo ve el
 * propio jugador (vida, habilidades, informe de ronda, marcador de compañeros).
 *
 *   GEP ──▶ TraductorJugador ──acciones──▶ aquí ──▶ EnlaceIngesta (aux_data)
 *   presencia (cliente_presente cada 12 s) ◀── te_llaman ── servidor
 *
 * Dos formas de entrar en un partido:
 *   · por matchId, sola, en una custom de bomba/swift (§3.3);
 *   · por grupo, cuando el operador pulsa "Call players" (§3.4).
 */

import { estadoPrograma, type Contexto } from './contexto.ts';
import { EnlaceIngesta } from './enlace/conexion.ts';
import { Presencia } from './enlace/presencia.ts';
import type { Accion, DatoGep } from './gep/acciones.ts';
import { TraductorJugador } from './gep/jugador.ts';
import { error, log } from './registro.ts';
import { normalizaIngesta } from './urls.ts';

const BUCLE_MS = 300;

export class ModoJugador {
  readonly traductor: TraductorJugador;
  readonly enlace: EnlaceIngesta;
  private presencia: Presencia | null = null;
  private bucle: NodeJS.Timeout | null = null;
  private readonly ctx: Contexto;

  constructor(ctx: Contexto) {
    this.ctx = ctx;
    this.traductor = new TraductorJugador(ctx.recuerdos.puuid());
    this.enlace = new EnlaceIngesta({
      version: ctx.version,
      avisos: {
        estado: (m, c) => estadoPrograma(ctx, m, c),
        // El jugador no tiene interfaz: los rechazos quedan en el log.
        dialogo: (t, m) => log(`${t}: ${m.replace(/\n+/g, ' ')}`),
        log,
        autenticado: (info) => {
          if (!info.porGrupo && this.traductor.matchId !== '') {
            void ctx.recuerdos.guardaMatchId(this.traductor.matchId).catch((e) => error('guardando el matchId', e));
          }
          this.arrancaBucle();
        },
        desconectado: () => {
          this.paraBucle();
          this.traductor.reinicia();
        },
      },
    });
  }

  /** Arranque: la presencia, sin esperar a ninguna partida. */
  arranca(): void {
    if (this.ctx.ingesta === null) {
      log('perfil de jugador sin ingestIp: no hay presencia ni conexión');
      return;
    }
    this.presencia = new Presencia({
      url: this.ctx.ingesta,
      puuid: () => this.traductor.puuid,
      alLlamar: (grupo) => this.alLlamar(grupo),
      log,
    });
    this.presencia.arranca();
  }

  procesa(dato: DatoGep): void {
    this.ejecuta(this.traductor.procesa(dato));
  }

  private ejecuta(acciones: Accion[]): void {
    for (const a of acciones) {
      switch (a.tipo) {
        case 'envia':
          if (!this.enlace.enviaJugador(a.type, a.data) && a.reintentoMs !== undefined) {
            setTimeout(() => this.enlace.enviaJugador(a.type, a.data), a.reintentoMs);
          }
          break;
        case 'conecta':
          if (a.retardoMs) setTimeout(() => this.disparaConexion(), a.retardoMs);
          else this.disparaConexion();
          break;
        case 'persistePuuid':
          void this.ctx.recuerdos.guardaPuuid(a.puuid).catch((e) => error('guardando el puuid', e));
          this.presencia?.late();
          break;
        case 'finConexion':
          this.enlace.cierra('Connection Closed');
          break;
        case 'estadoJuego':
          log(`juego: ${a.mensaje}`);
          break;
        case 'log':
          log(a.texto);
          break;
        default:
          break;
      }
    }
  }

  /** Disparo de conexión por matchId (§3.1.3 y §3.3). */
  private disparaConexion(): void {
    if (this.enlace.autenticado) return;
    if (this.enlace.abierto) this.enlace.cierra('Disconnected');
    if (this.ctx.ingesta === null) {
      log('disparo de conexión del jugador sin ingestIp: nada');
      return;
    }
    const matchId = this.traductor.matchId || this.ctx.recuerdos.matchIdVigente();
    if (matchId === '') {
      estadoPrograma(this.ctx, 'No Match ID', 'danger');
      return;
    }
    this.enlace.abre(normalizaIngesta(this.ctx.ingesta), {
      rol: 'jugador',
      nombre: this.traductor.nombre,
      puuid: this.traductor.puuid,
      matchId,
    });
  }

  /**
   * `te_llaman`: entrar por grupo. Cambios respecto al cliente anterior:
   *   · ya no se lee la sala del cliente de Riot en la PC del jugador (sólo
   *     servía para una línea de log y usaba la API gris);
   *   · el `name` del logon es el nombre de GEP (antes iba el puuid); sin
   *     nombre aún (jugador en el menú), se usa el puuid como antes;
   *   · una llamada repetida no abre otro logon si ya está conectado o
   *     entrando en ese grupo.
   */
  private alLlamar(grupo: string): void {
    if (this.enlace.autenticado) {
      log('te_llaman con conexión ya autenticada: nada que hacer');
      return;
    }
    if (this.enlace.abierto && this.enlace.porGrupo === grupo) {
      log(`te_llaman repetido para ${grupo}: ya se está entrando`);
      return;
    }
    if (this.ctx.ingesta === null) return;
    this.enlace.abre(normalizaIngesta(this.ctx.ingesta), {
      rol: 'jugador',
      nombre: this.traductor.nombre || this.traductor.puuid,
      puuid: this.traductor.puuid,
      grupo,
    });
  }

  /* ── Bucle de 300 ms (§3.3) ─────────────────────────────────────────────── */

  private arrancaBucle(): void {
    this.paraBucle();
    this.bucle = setInterval(() => this.ejecuta(this.traductor.tick()), BUCLE_MS);
  }

  private paraBucle(): void {
    if (this.bucle !== null) clearInterval(this.bucle);
    this.bucle = null;
  }

  apaga(): void {
    this.paraBucle();
    this.presencia?.para();
    this.enlace.cierra();
  }
}
