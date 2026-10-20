/**
 * El modo observador: la PC del realizador.
 *
 * Junta las piezas y ejecuta lo que decide el traductor de GEP:
 *
 *   GEP ──▶ TraductorObservador ──acciones──▶ aquí ──▶ EnlaceIngesta (5100)
 *                                                   ├─▶ panel (IPC)
 *                                                   └─▶ teclas, secreto…
 *
 * Además atiende al panel: la sesión (`conecta`), el servidor local del
 * overlay, el lector de sala, crear sala, "Call players", las teclas globales
 * y la ventana operador.
 */

import { dialog, globalShortcut, type BrowserWindow } from 'electron';
import { planAtajos, type PlanAtajos } from './atajos.ts';
import { CANALES } from './canales.ts';
import { dialogo, enviaAlPanel, estadoJuego, estadoPrograma, type Contexto } from './contexto.ts';
import { EnlaceIngesta } from './enlace/conexion.ts';
import type { Accion, DatoGep } from './gep/acciones.ts';
import { TraductorObservador } from './gep/observador.ts';
import { ServidorLocal } from './local/servidor-local.ts';
import { recorta, error, log } from './registro.ts';
import { ResolutorRiot } from './riot/contexto.ts';
import { Colocador, leeColocacion } from './riot/coloca.ts';
import { creaSalaTorneo, type ResultadoSala } from './riot/crea-sala.ts';
import { Rangos } from './riot/rango.ts';
import { LectorSala } from './riot/sala.ts';
import { raizOverlay } from './rutas.ts';
import { INGESTA_POR_DEFECTO } from './perfil.ts';
import { derivaSalida, normalizaIngesta } from './urls.ts';
import { VentanaOperador } from './ventanas.ts';
import { DetectorPausa } from './sistema/detector-pausa.ts';
import { CapturaFlujo } from './sistema/captura-flujo.ts';

/** Lecturas seguidas sin sala (a 1 s cada una) antes de decirle al servidor que ya no hay sala. */
const LECTURAS_SIN_SALA = 4;

/** Espera antes de reabrir la conexión tras un fin de partida. */
const RECONEXION_TRAS_FIN_MS = 2500;

export class ModoObservador {
  readonly riot = new ResolutorRiot();
  readonly rangos: Rangos;
  readonly traductor: TraductorObservador;
  readonly enlace: EnlaceIngesta;
  readonly local: ServidorLocal;
  readonly lector: LectorSala;
  /** Pone a cada jugador en su lado de la sala de Riot (lo pide el panel). */
  readonly colocador: Colocador;
  readonly operador: VentanaOperador;
  private readonly ctx: Contexto;
  /** Token y grupo del shell: sólo en memoria, para la reconexión automática. */
  private sesion: { token: string; grupo: string } | null = null;
  /** Reconexión pendiente tras acabar una partida (ver `reconectaTrasFin`). */
  private relojReconexion: ReturnType<typeof setTimeout> | null = null;
  private plan: PlanAtajos | null = null;
  private lecturasSinSala = 0;
  private salaOlvidada = false;
  private atajosActivos: string[] = [];

  constructor(ctx: Contexto) {
    this.ctx = ctx;
    this.rangos = new Rangos({ riot: this.riot, claveHenrik: ctx.claveHenrik, log });
    this.traductor = new TraductorObservador({ rangoEnCache: (p) => this.rangos.enCache(p) });
    this.enlace = new EnlaceIngesta({
      version: ctx.version,
      secreto: () => ctx.recuerdos.secretoVigente(),
      avisos: {
        estado: (m, c) => estadoPrograma(ctx, m, c),
        dialogo: (t, m, tipo) => dialogo(ctx, t, m, tipo),
        log,
        autenticado: (info) => {
          if (info.secreto) void ctx.recuerdos.recuerdaSecreto(info.secreto).catch((e) => error('guardando el secreto', e));
          this.activaAtajos();
          this.ejecuta(this.traductor.alAutenticar());
        },
        desconectado: () => this.desactivaAtajos(),
      },
    });
    this.colocador = new Colocador({
      riot: this.riot,
      puuidPropio: async () => (await this.riot.contexto())?.puuid ?? '',
      log,
    });
    this.local = new ServidorLocal({ raiz: raizOverlay(ctx.empaquetado), puerto: ctx.puertoLocal, log });
    this.lector = new LectorSala({
      riot: this.riot,
      rango: (p) => this.rangos.enCache(p),
      pideRango: (p) => void this.rangos.resuelve(p),
      entrega: (sala) => {
        enviaAlPanel(ctx, CANALES.salaLocal, sala);
        if (sala !== null) {
          this.lecturasSinSala = 0;
          this.salaOlvidada = false;
          this.enlace.enviaSala(sala);
        } else if (!this.salaOlvidada && ++this.lecturasSinSala >= LECTURAS_SIN_SALA) {
          // Varias lecturas seguidas sin sala (no un tropiezo de la API): se le dice al servidor que ya no hay.
          this.salaOlvidada = this.enlace.enviaSala(null) || this.salaOlvidada;
        }
        void this.colocador.aplica(sala);
      },
      log,
    });
    this.operador = new VentanaOperador(() => `http://localhost:${this.local.puerto || ctx.puertoLocal}/operador/`);
    // El juego se pone en gris en cada timeout / pausa técnica: se detecta mirando la pantalla (5 veces por segundo).
    if (process.env.EASY_SIN_PAUSA_VISUAL !== '1') {
      const detector = new DetectorPausa({
        captura: async () => null, // las medidas llegan del flujo de vídeo, no se piden
        alCambiar: (activa) => enviaAlPanel(ctx, CANALES.pausaVisual, { activa }),
        log,
      });
      this.pausaVisual = detector;
      this.flujoPausa = new CapturaFlujo((m) => detector.procesa(m), log);
      // Sólo para comprobar el detector sin partida: mide siempre, no sólo en la compra.
      if (process.env.EASY_PAUSA_SIEMPRE === '1') void this.flujoPausa.arranca();
    }
  }

  private pausaVisual: DetectorPausa | null = null;
  private flujoPausa: CapturaFlujo | null = null;

  private get urlIngesta(): string {
    return normalizaIngesta(this.ctx.ingesta ?? INGESTA_POR_DEFECTO);
  }

  get urlObs(): string {
    return `http://localhost:${this.local.puerto || this.ctx.puertoLocal}/`;
  }

  /* ── GEP ────────────────────────────────────────────────────────────────── */

  info(dato: DatoGep): void {
    this.siguePausa(dato);
    this.ejecuta(this.traductor.info(dato));
  }

  evento(dato: DatoGep): void {
    this.siguePausa(dato);
    this.ejecuta(this.traductor.evento(dato));
  }

  /** Sucesos del propio GEP: el juego detectado abre la ráfaga en la que se ignora el estado viejo repetido. */
  sucesoGep(tipo: string): void {
    if (tipo === 'game-detected') this.traductor.juegoDetectado();
    else if (tipo === 'game-exit') this.traductor.juegoCerrado();
  }

  /**
   * Los tiempos muertos y la pausa técnica SÓLO se piden en la fase de compra: el detector de pantalla sólo mira
   * entonces (así no gasta CPU el resto de la ronda y no puede confundirse con nada de otra fase).
   */
  private siguePausa(dato: DatoGep): void {
    if (dato.key !== 'round_phase' || this.pausaVisual === null || this.flujoPausa === null) return;
    if (dato.value === 'shopping') {
      void this.flujoPausa.arranca();
    } else {
      this.flujoPausa.para();
      this.pausaVisual.para();
    }
  }

  private ejecuta(acciones: Accion[]): void {
    for (const a of acciones) {
      switch (a.tipo) {
        case 'envia':
          this.enlace.enviaObservador(a.type, a.data);
          break;
        case 'estadoJuego':
          estadoJuego(this.ctx, a.mensaje, a.clase);
          break;
        case 'fase':
          break; // la lee la tecla de spike de `traductor.faseActual`
        case 'finMapa':
          log(`serie-mapa-fin: ${a.datos.izq}-${a.datos.der}, gana ${a.datos.ganador} (${a.datos.map}, ${a.datos.roster.length} jugadores)`);
          enviaAlPanel(this.ctx, CANALES.serieFin, a.datos);
          break;
        case 'finConexion':
          this.enlace.cierra('Connection Closed');
          this.reconectaTrasFin();
          break;
        case 'conecta':
          this.disparaConexion();
          break;
        case 'persisteSecreto':
          void this.ctx.recuerdos.repersisteSecreto().catch((e) => error('re-guardando el secreto', e));
          break;
        case 'resuelveRango': {
          const r = a.roster;
          void this.rangos.resuelve(String(r.playerId)).then((rango) => {
            if (rango !== undefined && rango !== r.rank) this.enlace.enviaObservador('roster', { ...r, rank: rango });
          });
          break;
        }
        case 'persistePuuid':
          break;
        case 'log':
          log(a.texto);
          break;
      }
    }
  }

  /* ── Conexión ───────────────────────────────────────────────────────────── */

  /** `conecta` del shell: token y grupo de la sesión de cuentas. */
  conecta(token: unknown, grupo: unknown): void {
    if (typeof token !== 'string' || token === '' || typeof grupo !== 'string' || grupo === '') {
      log('conecta sin token o sin grupo: no se conecta');
      return;
    }
    const igual = this.sesion?.token === token && this.sesion.grupo === grupo;
    this.sesion = { token, grupo };
    // El panel lo pide al arrancar un match o crear la sala: con la conexión ya viva (o en camino) con
    // esta misma sesión no se toca (reabrirla tiraría el partido que hay en el servidor).
    if (igual && (this.enlace.autenticado || this.enlace.abierto)) return;
    log(`conecta: grupo ${grupo.toUpperCase()}, token ${recorta(token)}`);
    this.enlace.abre(this.urlIngesta, { rol: 'observador', token, grupo });
  }

  /**
   * Acabada una partida se cierra la conexión (el servidor da el partido por terminado), pero el
   * panel sigue trabajando: Quick match, Call players, crear la sala… necesitan un observador
   * conectado. Sin esto la conexión no volvía hasta la siguiente selección de agentes y, entre
   * partidas, el panel se quedaba sin equipos, sin sala y con «No conectado como observador».
   * Se espera un poco: GEP a veces repite el fin de mapa y cada uno reinicia la cuenta.
   */
  private reconectaTrasFin(): void {
    if (this.relojReconexion !== null) clearTimeout(this.relojReconexion);
    this.relojReconexion = setTimeout(() => {
      this.relojReconexion = null;
      if (this.sesion === null || this.enlace.abierto) return;
      log('reconexión tras el fin de la partida: el panel sigue necesitando un observador conectado');
      this.enlace.abre(this.urlIngesta, { rol: 'observador', ...this.sesion });
    }, RECONEXION_TRAS_FIN_MS);
  }

  /** Disparo automático (escena de selección de agentes, §3.1.3). */
  private disparaConexion(): void {
    if (this.enlace.autenticado) return;
    if (this.enlace.abierto) this.enlace.cierra('Disconnected');
    if (this.sesion === null) {
      log('disparo de conexión sin sesión del panel: se espera al shell');
      return;
    }
    this.enlace.abre(this.urlIngesta, { rol: 'observador', ...this.sesion });
  }

  /* ── Servidor local y sala ──────────────────────────────────────────────── */

  arrancaOverlayLocal(token: unknown, grupo: unknown): void {
    if (typeof token !== 'string' || token === '' || typeof grupo !== 'string' || grupo === '') {
      log('arranca-overlay-local sin credenciales: ignorado');
      return;
    }
    void this.local.arranca({ endpoint: derivaSalida(this.urlIngesta), token, grupo });
  }

  creaSala(): Promise<ResultadoSala> {
    return creaSalaTorneo(this.riot);
  }

  /** El panel dice quién va en qué lado; el colocador mueve a quien esté en el lado equivocado. */
  colocaJugadores(carga: unknown): void {
    this.colocador.fija(leeColocacion(carga));
  }

  llamaJugadores(puuids: unknown) {
    const lista = Array.isArray(puuids) ? puuids.filter((p): p is string => typeof p === 'string' && p !== '') : [];
    return this.enlace.llamaJugadores(lista);
  }

  /* ── Teclas globales (§7) ───────────────────────────────────────────────── */

  aplicaAtajos(carga: unknown): void {
    const plan = planAtajos(carga);
    if (plan === null) return;
    this.plan = plan;
    for (const tecla of plan.invalidas) dialogo(this.ctx, 'Easy HUD - Error', `The hotkey on ${tecla} is invalid!`, 'error');
    this.desactivaAtajos();
    // Se registran sólo con conexión autenticada: sin ella las pulsaciones se perderían y la tecla quedaría robada.
    if (this.enlace.autenticado) this.activaAtajos();
  }

  private activaAtajos(): void {
    this.desactivaAtajos();
    if (this.plan === null) return;
    for (const r of this.plan.registros) {
      const ok = globalShortcut.register(r.tecla, () => {
        if (r.mando === 'spikePlanted' && this.traductor.faseActual !== 'combat') return;
        this.enlace.enviaObservador(r.type, true);
      });
      if (ok) this.atajosActivos.push(r.tecla);
      else log(`no se pudo registrar ${r.tecla} (${r.mando}): la tiene otra aplicación`);
    }
    if (this.atajosActivos.length > 0) log(`teclas activas: ${this.atajosActivos.join(', ')}`);
  }

  desactivaAtajos(): void {
    for (const t of this.atajosActivos) globalShortcut.unregister(t);
    this.atajosActivos = [];
  }

  /* ── Cierre (§1.5) ──────────────────────────────────────────────────────── */

  /** ¿Se puede cerrar ya? Si está en directo, pregunta. */
  async confirmaCierre(v: BrowserWindow): Promise<boolean> {
    if (!this.enlace.autenticado) return true;
    const r = await dialog.showMessageBox(v, {
      type: 'warning',
      title: 'Easy HUD',
      message: 'Estás en directo',
      detail: 'El observador está conectado y alimentando la emisión. Si cierras ahora, el overlay se queda sin datos.',
      buttons: ['Cancelar', 'Cerrar'],
      defaultId: 0,
      cancelId: 0,
    });
    return r.response === 1;
  }

  async apaga(): Promise<void> {
    this.flujoPausa?.destruye();
    this.pausaVisual?.para();
    this.lector.para();
    this.desactivaAtajos();
    this.operador.destruye();
    await this.local.para();
  }
}
