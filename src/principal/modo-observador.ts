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
import { creaSalaTorneo, type ResultadoSala } from './riot/crea-sala.ts';
import { Rangos } from './riot/rango.ts';
import { LectorSala } from './riot/sala.ts';
import { raizOverlay } from './rutas.ts';
import { INGESTA_POR_DEFECTO } from './perfil.ts';
import { derivaSalida, normalizaIngesta } from './urls.ts';
import { VentanaOperador } from './ventanas.ts';

export class ModoObservador {
  readonly riot = new ResolutorRiot();
  readonly rangos: Rangos;
  readonly traductor: TraductorObservador;
  readonly enlace: EnlaceIngesta;
  readonly local: ServidorLocal;
  readonly lector: LectorSala;
  readonly operador: VentanaOperador;
  private readonly ctx: Contexto;
  /** Token y grupo del shell: sólo en memoria, para la reconexión automática. */
  private sesion: { token: string; grupo: string } | null = null;
  private plan: PlanAtajos | null = null;
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
    this.local = new ServidorLocal({ raiz: raizOverlay(ctx.empaquetado), puerto: ctx.puertoLocal, log });
    this.lector = new LectorSala({
      riot: this.riot,
      rango: (p) => this.rangos.enCache(p),
      pideRango: (p) => void this.rangos.resuelve(p),
      entrega: (sala) => {
        enviaAlPanel(ctx, CANALES.salaLocal, sala);
        if (sala !== null) this.enlace.enviaSala(sala);
      },
      log,
    });
    this.operador = new VentanaOperador(() => `http://localhost:${this.local.puerto || ctx.puertoLocal}/operador/`);
  }

  private get urlIngesta(): string {
    return normalizaIngesta(this.ctx.ingesta ?? INGESTA_POR_DEFECTO);
  }

  get urlObs(): string {
    return `http://localhost:${this.local.puerto || this.ctx.puertoLocal}/`;
  }

  /* ── GEP ────────────────────────────────────────────────────────────────── */

  info(dato: DatoGep): void {
    this.ejecuta(this.traductor.info(dato));
  }

  evento(dato: DatoGep): void {
    this.ejecuta(this.traductor.evento(dato));
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
    this.sesion = { token, grupo };
    log(`conecta: grupo ${grupo.toUpperCase()}, token ${recorta(token)}`);
    this.enlace.abre(this.urlIngesta, { rol: 'observador', token, grupo });
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
    this.lector.para();
    this.desactivaAtajos();
    this.operador.destruye();
    await this.local.para();
  }
}
