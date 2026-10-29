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

import { clipboard, dialog, globalShortcut, type BrowserWindow } from 'electron';
import { planAtajos, separaChoques, textoAtajosFallidos, type AtajosFallidos, type PlanAtajos } from './atajos.ts';
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
import { type Comprobacion, type ComprobadorArranque, problemas, textoComprobaciones } from './sistema/arranque.ts';
import { CapturaFlujo } from './sistema/captura-flujo.ts';
import { conLimite, ejecutaPasos, padreDeDialogo } from './sistema/robustez.ts';

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
  private tomadasAvisadas = '';
  /** Credenciales con las que el panel arrancó el overlay local, y si tiene el lector de sala en marcha. */
  private overlay: { token: string; grupo: string } | null = null;
  private lectorActivo = false;
  private comprobador: ComprobadorArranque | null = null;
  private dialogoComprobaciones = false;
  /** Ya se avisó de «partida en marcha sin sesión» (se reanuda al iniciar sesión). */
  private avisadoSinSesion = false;

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
    this.local = new ServidorLocal({
      raiz: raizOverlay(ctx.empaquetado),
      puerto: ctx.puertoLocal,
      log,
      alFallar: (texto) => dialogo(ctx, 'Easy HUD - Overlay server not started', texto, 'error'),
    });
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
    // Desactivado por defecto: los tiempos muertos y la pausa técnica son MANUALES (botones del panel y atajos de teclado,
    // como siempre). La detección por pantalla sólo se enciende con EASY_PAUSA_VISUAL=1.
    if (process.env.EASY_PAUSA_VISUAL === '1') {
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
    this.avisadoSinSesion = false;
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
      // La partida ya está en la selección de agentes y el observador no está conectado: sin esto el operador
      // sólo se enteraría al ver el overlay vacío. Se avisa una vez (hasta que el panel mande la sesión).
      if (!this.avisadoSinSesion) {
        this.avisadoSinSesion = true;
        dialogo(
          this.ctx,
          'Easy HUD - Not connected',
          'The match is starting but Easy HUD is not connected to the broadcast yet, so the overlay will have no data. In the panel, sign in and start your match (or create the room) now; it connects by itself.',
          'warning',
        );
      }
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
    this.overlay = { token, grupo };
    void this.local.arranca({ endpoint: derivaSalida(this.urlIngesta), token, grupo });
  }

  /** El panel pide parar el overlay local: ya no hay nada que reiniciar en «Reconnect everything». */
  paraOverlayLocal(): void {
    this.overlay = null;
    void this.local.para();
  }

  /** El lector de sala se arranca y se para desde el panel; se recuerda para poder reiniciarlo. */
  arrancaLector(): void {
    this.lectorActivo = true;
    this.lector.arranca(1000);
  }

  paraLector(): void {
    this.lectorActivo = false;
    this.lector.para();
  }

  /**
   * «Reconnect everything»: un solo gesto (Ctrl+Alt+R o el menú de la bandeja) que deja el programa como
   * recién conectado, sin tener que cerrar ni reiniciar nada: cierra el socket de datos y lo abre de
   * nuevo con la sesión actual (el secreto de reconexión retoma el partido en el servidor), reinicia el
   * overlay local que ve OBS y el lector de sala, y olvida los tokens de Riot para que se renueven.
   * Devuelve un resumen para decírselo al operador.
   */
  async reconectaTodo(): Promise<string[]> {
    log('Reconnect everything: pedido por el operador');
    if (this.relojReconexion !== null) clearTimeout(this.relojReconexion);
    this.relojReconexion = null;
    // Cada paso es independiente: si uno falla (o se queda esperando) los demás se hacen igual y se le dice al operador.
    // La conexión con el servidor va PRIMERO: es lo que más urge en directo.
    const { lineas } = await ejecutaPasos([
      {
        nombre: 'Server connection',
        ejecuta: () => {
          if (this.sesion === null) return 'no signed-in session yet: nothing to reconnect to the server';
          this.enlace.cierra('Disconnected');
          this.enlace.abre(this.urlIngesta, { rol: 'observador', ...this.sesion });
          return 'server connection reopened';
        },
      },
      {
        nombre: 'Riot session',
        ejecuta: () => {
          this.riot.olvida();
          return undefined;
        },
      },
      {
        nombre: 'Lobby reader',
        ejecuta: () => {
          if (!this.lectorActivo) return undefined;
          this.lector.para();
          this.lector.arranca(1000);
          return 'lobby reader restarted';
        },
      },
      {
        nombre: 'Overlay server',
        ejecuta: async () => {
          if (this.overlay === null) return undefined;
          // Un cierre que no termina (una conexión de OBS colgada) no puede dejar el gesto a medias.
          if (!(await conLimite(this.local.para(), 6000))) log('servidor local: el cierre tardó más de 6 s, se sigue igual');
          await this.local.arranca({ endpoint: derivaSalida(this.urlIngesta), ...this.overlay });
          return this.local.enMarcha ? 'overlay server restarted' : 'overlay server did NOT restart (see the port message)';
        },
      },
    ]);
    return lineas;
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
    this.desactivaAtajos();
    // Se registran sólo con conexión autenticada: sin ella las pulsaciones se perderían y la tecla quedaría robada.
    if (this.enlace.autenticado) this.activaAtajos();
    // Sin conexión aún no se registra nada: el aviso (con todo junto, en un solo diálogo) sale al conectar.
    else log(`teclas recibidas sin conexión (${plan.registros.length} por registrar, ${plan.invalidas.length} inválidas): se registran al autenticar`);
  }

  private choquesDelPlan(plan: PlanAtajos) {
    const { libres, choques } = separaChoques(plan.registros);
    return { libres, choques, invalidas: plan.invalidas };
  }

  /** Un solo diálogo con todo lo que no va a funcionar; el mismo aviso no se repite (una vez por combinación de fallos). */
  private avisaAtajos(f: AtajosFallidos): void {
    const texto = textoAtajosFallidos(f);
    if (texto === null) {
      this.tomadasAvisadas = '';
      return;
    }
    if (texto === this.tomadasAvisadas) return;
    this.tomadasAvisadas = texto;
    dialogo(this.ctx, 'Easy HUD - Hotkeys not available', texto, 'warning');
  }

  // Adaptado de ValoSpectra/Spectra-Client (GPL-3.0) — services/hotkeyService.ts (activateHotkey: registrar cada tecla
  // activada; el original ignoraba si `register` fallaba).
  private activaAtajos(): void {
    this.desactivaAtajos();
    if (this.plan === null) return;
    const { libres, choques, invalidas } = this.choquesDelPlan(this.plan);
    const ocupadas: AtajosFallidos['ocupadas'] = [];
    const ilegales: AtajosFallidos['ilegales'] = [];
    for (const r of libres) {
      let ok = false;
      let lanzo = false;
      try {
        ok = globalShortcut.register(r.tecla, () => {
          try {
            if (r.mando === 'spikePlanted' && this.traductor.faseActual !== 'combat') return;
            this.enlace.enviaObservador(r.type, true);
          } catch (e) {
            error(`ejecutando la tecla ${r.tecla}`, e);
          }
        });
      } catch (e) {
        // Electron lanza (no devuelve false) si no sabe convertir la tecla: no es que la tenga otro programa.
        lanzo = true;
        error(`registrando la tecla ${r.tecla}`, e);
      }
      if (ok) this.atajosActivos.push(r.tecla);
      else if (lanzo) {
        log(`la tecla ${r.tecla} (${r.mando}) no se puede usar como atajo global`);
        ilegales.push(r);
      } else {
        log(`no se pudo registrar ${r.tecla} (${r.mando}): la tiene otra aplicación`);
        ocupadas.push(r);
      }
    }
    for (const c of choques) log(`tecla ${c.tecla} (${c.mando}) sin registrar: ${c.motivo}`);
    if (this.atajosActivos.length > 0) log(`teclas activas: ${this.atajosActivos.join(', ')}`);
    // Una tecla que no se pudo registrar no hace NADA en directo: se avisa.
    this.avisaAtajos({ ocupadas, ilegales, choques, invalidas });
  }

  desactivaAtajos(): void {
    for (const t of this.atajosActivos) globalShortcut.unregister(t);
    this.atajosActivos = [];
  }

  /* ── Comprobaciones de arranque ─────────────────────────────────────────── */

  /** Las crea `principal.ts` (sabe de GEP y del perfil). */
  fijaComprobador(c: ComprobadorArranque): void {
    this.comprobador = c;
  }

  /**
   * Pasa las comprobaciones y las enseña: con `problemas` sólo si hay algo que arreglar (así no molesta si
   * va todo bien); con `siempre` también cuando está todo bien (la pide el operador desde la bandeja).
   * El diálogo deja repetir la pasada tras arreglar algo y copiar el detalle para pegarlo en un mensaje.
   */
  async ejecutaComprobaciones(mostrar: 'problemas' | 'siempre'): Promise<Comprobacion[]> {
    if (this.comprobador === null) return [];
    // Un solo diálogo a la vez: pulsar dos veces el menú no apila ventanas.
    if (this.dialogoComprobaciones) return [];
    this.dialogoComprobaciones = true;
    try {
      return await this.pasaComprobaciones(mostrar);
    } finally {
      this.dialogoComprobaciones = false;
    }
  }

  private async pasaComprobaciones(mostrar: 'problemas' | 'siempre'): Promise<Comprobacion[]> {
    if (this.comprobador === null) return [];
    let lista: Comprobacion[] = [];
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      try {
        lista = await this.comprobador.ejecuta();
      } catch (e) {
        error('comprobaciones de arranque', e);
        return lista;
      }
      log(`comprobaciones de arranque:\n${textoComprobaciones(lista)}`);
      const malos = problemas(lista);
      if (malos.length === 0 && mostrar === 'problemas') return lista;
      const v = padreDeDialogo(this.ctx.ventana());
      const opciones = {
        type: malos.some((c) => c.nivel === 'error') ? ('error' as const) : malos.length > 0 ? ('warning' as const) : ('info' as const),
        title: 'Easy HUD - Setup check',
        message: malos.length === 0 ? 'Everything looks good.' : `${malos.length} thing${malos.length === 1 ? '' : 's'} to fix before going live`,
        detail: textoComprobaciones(lista, malos.length > 0),
        buttons: ['OK', 'Check again', 'Copy details'],
        defaultId: 0,
        cancelId: 0,
      };
      const { response } = await (v !== null ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones));
      if (response === 2) {
        clipboard.writeText(textoComprobaciones(lista));
        return lista;
      }
      if (response !== 1) return lista;
      mostrar = 'siempre'; // «Check again»: se vuelve a enseñar el resultado, sea cual sea
    }
    return lista;
  }

  /* ── Cierre (§1.5) ──────────────────────────────────────────────────────── */

  /** ¿Se puede cerrar ya? Si está en directo, pregunta. */
  async confirmaCierre(v: BrowserWindow | null): Promise<boolean> {
    if (!this.enlace.autenticado) return true;
    const opciones = {
      type: 'warning' as const,
      title: 'Easy HUD',
      message: 'You are live',
      detail: 'The observer is connected and feeding the broadcast. If you close now, the overlay will run out of data.',
      buttons: ['Cancel', 'Close'],
      defaultId: 0,
      cancelId: 0,
    };
    const padre = padreDeDialogo(v);
    const r = await (padre !== null ? dialog.showMessageBox(padre, opciones) : dialog.showMessageBox(opciones));
    return r.response === 1;
  }

  async apaga(): Promise<void> {
    // Cierre limpio: sin reconexión pendiente y con el socket cerrado de verdad (el servidor lo ve como una
    // salida normal y deja el partido huérfano para que el próximo arranque lo retome con el secreto).
    if (this.relojReconexion !== null) clearTimeout(this.relojReconexion);
    this.relojReconexion = null;
    this.enlace.cierra('Disconnected');
    this.flujoPausa?.destruye();
    this.pausaVisual?.para();
    this.lector.para();
    this.desactivaAtajos();
    this.operador.destruye();
    await this.local.para();
  }
}
