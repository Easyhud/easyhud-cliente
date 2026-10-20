/**
 * El modo jugador ("auxiliar"): vive en la bandeja y manda lo que sólo ve el
 * propio jugador (vida, habilidades, informe de ronda, marcador de compañeros).
 *
 *   GEP ──▶ TraductorJugador ──acciones──▶ aquí ──▶ EnlaceIngesta (aux_data)
 *   presencia (cliente_presente cada 12 s) ◀── te_llaman ── servidor
 *
 * El puuid de la presencia sale del cliente de Riot local en cuanto el
 * jugador tiene sesión (menús incluidos) y, si no, del de GEP o el guardado:
 * así el panel ve "Ready" sin esperar a la primera partida.
 *
 * Dos formas de entrar en un partido:
 *   · por matchId, sola, en una custom de bomba/swift (§3.3);
 *   · por grupo, cuando el operador pulsa "Call players" (§3.4).
 *
 * Tiene que funcionar sí o sí, y cuando no puede, DECIRLO: lleva un diagnóstico propio
 * (`Diagnostico`) que va en cada latido al servidor —el panel lo ve por jugador— y que alimenta
 * las alertas al jugador (notificación y bandeja) en vez de fallar en silencio.
 */

import { estadoPrograma, type Contexto } from './contexto.ts';
import { CamaraJugador } from './camara/camara.ts';
import { Diagnostico, type Alerta, type CargaDiagnostico, type EstadoRed } from './diagnostico/diagnostico.ts';
import { GrabadoraGep } from './diagnostico/grabadora-gep.ts';
import { armaInforme } from './diagnostico/informe.ts';
import { consejo, ejecutaAutoprueba, type ResultadoAutoprueba } from './diagnostico/autoprueba.ts';
import { urlSonda } from './diagnostico/sonda.ts';
import { EnlaceIngesta } from './enlace/conexion.ts';
import { Presencia } from './enlace/presencia.ts';
import type { Accion, DatoGep } from './gep/acciones.ts';
import type { EstadoGep } from './gep/adaptador.ts';
import { aplanaInfo, SondeoInfo } from './gep/info-sondeo.ts';
import { TraductorJugador } from './gep/jugador.ts';
import { colaDelLog, error, log } from './registro.ts';
import { ResolutorRiot } from './riot/contexto.ts';
import { FuentePuuid, leePuuidLocal, leeRiotIdLocal } from './riot/puuid-local.ts';
import { uneASalaPorCodigo } from './riot/une-sala.ts';
import { pideRegla, reglaExiste } from './sistema/firewall.ts';
import { buscaConflictos } from './sistema/conflictos.ts';
import { leeEntornoDelPc } from './sistema/entorno.ts';
import { todosLosProcesos, valorantAbierto } from './sistema/procesos.ts';
import { normalizaIngesta } from './urls.ts';

const BUCLE_MS = 300;
/** Primera espera antes de volver a entrar al grupo tras perder la conexión (luego crece). */
const ESPERA_GRUPO_MS = 10_000;
const SEIS_HORAS_MS = 6 * 3600_000;
/** Cada cuánto se refresca el estado interno y se evalúan las alertas. */
const ESTADO_MS = 5_000;
const JUEGO_MS = 10_000;
const SONDA_MS = 15_000;
/** Una alerta que sigue activa se vuelve a notificar pasado este tiempo. */
const RENOTIFICA_MS = 15 * 60_000;

/** Cómo avisa el programa al jugador (lo pone `principal.ts`: notificación del sistema y bandeja). */
export interface AvisosJugador {
  /** Una alerta nueva (o que sigue sin resolverse tras mucho rato). */
  notifica(alerta: Alerta): void;
  /** Cambió el conjunto de alertas activas (para el icono de la bandeja). */
  alCambiar(alertas: Alerta[]): void;
  /** La autoprueba dice que el puerto del servidor está bloqueado: ofrecer al jugador la regla del Firewall. */
  ofreceFirewall?(motivo: string): void;
}

/** Un problema que saltó en esta sesión: cuándo empezó y, si ya se arregló, cuándo acabó. */
export interface EntradaHistorial {
  id: string;
  titulo: string;
  nivel: Alerta['nivel'];
  /** Instante (ms desde 1970) en que saltó. */
  desde: number;
  /** Instante en que dejó de ser cierto; `null` = sigue. */
  hasta: number | null;
}

/** Todo lo que enseña la ventana del jugador. */
export interface EstadoJugadorUI {
  diag: CargaDiagnostico;
  red: EstadoRed;
  alertas: Alerta[];
  /** Problemas de esta sesión (los resueltos también): para no confundirlos con los de ahora. */
  historial: EntradaHistorial[];
  version: string;
  /** `Nombre#TAG` del jugador (vacío si aún no se conoce). */
  jugador: string;
  /** La última autoprueba de red, y si está la regla del Firewall (`null` = no se ha mirado). */
  pruebaRed: ResultadoAutoprueba | null;
  reglaFirewall: boolean | null;
  probandoRed: boolean;
}

export class ModoJugador {
  readonly traductor: TraductorJugador;
  readonly enlace: EnlaceIngesta;
  readonly diag: Diagnostico;
  /** La «caja negra»: todo lo que Overwolf entrega (y cuándo), para saber con certeza qué le falta a un PC. */
  readonly grabadora = new GrabadoraGep();
  private presencia: Presencia | null = null;
  private readonly fuente: FuentePuuid;
  private bucle: NodeJS.Timeout | null = null;
  readonly camara: CamaraJugador;
  /** La cámara es privada: apagada en cada arranque, sólo la enciende el jugador. */
  private camaraEncendida = false;
  /** El cliente de Riot local, y si ya hay una unión a la sala en marcha. */
  private readonly riot = new ResolutorRiot();
  private uniendo = false;
  /** `Nombre#TAG` según el cliente de Riot local (respaldo si GEP no da el TAG). */
  private riotId = '';
  private relojRiotId: NodeJS.Timeout | null = null;
  private readonly ctx: Contexto;
  private gep: EstadoGep | null = null;
  private avisos: AvisosJugador | null = null;
  private readonly relojes: NodeJS.Timeout[] = [];
  private readonly avisadas = new Map<string, number>();
  private firmaAlertas = '';
  private readonly historial: EntradaHistorial[] = [];
  private sondeando = false;
  private conflictosVistos = '';
  /** El grupo al que lo llamó el operador: si pierde la conexión, vuelve a entrar solo. */
  private grupoRecordado = '';
  private grupoDesde = 0;
  private esperaGrupoMs = ESPERA_GRUPO_MS;
  private proximoIntentoGrupo = 0;
  /** Pregunta a GEP por su estado completo: red de seguridad de los avisos que Overwolf no manda. */
  private readonly sondeoInfo: SondeoInfo;
  /** Qué pasó la última vez que intentó unirse a la sala de Riot (para el diagnóstico). */
  private estadoSala = '';
  private infoClavesActual: string[] | null = null;
  private generandoInforme = false;
  private pruebaRed: ResultadoAutoprueba | null = null;
  private probandoRed = false;
  private reglaFirewall: boolean | null = null;
  private firewallOfrecido = false;

  constructor(ctx: Contexto) {
    this.ctx = ctx;
    this.diag = new Diagnostico(ctx.version);
    this.traductor = new TraductorJugador(ctx.recuerdos.puuid());
    // Si cerró el programa (o se le apagó el PC) hace poco estando llamado a un grupo, vuelve a entrar solo.
    const guardado = ctx.almacen.lee('grupoJugador');
    if (typeof guardado.grupo === 'string' && guardado.grupo !== '' && Date.now() - (guardado.desde ?? 0) < SEIS_HORAS_MS) {
      this.grupoRecordado = guardado.grupo;
      this.grupoDesde = guardado.desde ?? Date.now();
    }
    this.fuente = new FuentePuuid({
      lee: () => leePuuidLocal(),
      respaldo: () => this.traductor.puuid,
      alCambiar: (puuid) => {
        log(`puuid del jugador para la presencia: ${puuid.slice(0, 8)}…`);
        if (puuid !== ctx.recuerdos.puuid()) {
          void ctx.recuerdos.guardaPuuid(puuid).catch((e) => error('guardando el puuid', e));
        }
        this.presencia?.late();
      },
    });
    this.sondeoInfo = new SondeoInfo({
      lee: () => (this.gep !== null && this.gep.detectado ? this.gep.leeInfo() : Promise.reject(new Error('sin juego'))),
      entrega: (d) => {
        // En el menú, `getInfo` puede traer lo último de la partida anterior: no vale.
        if (this.traductor.enMenu) return;
        this.diag.cuentaEvento(`info_${d.key}`);
        this.grabadora.registra('sondeo', d.key, d.value);
        this.ejecuta(this.traductor.procesa({ key: d.key, value: d.value }));
        this.diag.fijaEspectador(this.traductor.soyEspectador);
      },
      alLeer: (claves) => {
        this.infoClavesActual = claves;
        this.diag.fijaInfoClaves(claves);
      },
      log,
    });
    this.camara = new CamaraJugador({
      anuncia: (publicando, id) => this.manda('aux_cam', { publishing: publicando, id }),
      // En desarrollo se puede forzar el nombre (`EASY_CAM_NOMBRE=Nick#TAG`) para probar sin partida.
      nombre: () => (ctx.desarrollo && process.env.EASY_CAM_NOMBRE) || this.nombreCompleto(),
      permitida: () => this.camaraEncendida,
      dispositivo: () => process.env.EASY_CAM_DEVICE ?? ctx.almacen.lee('camara').dispositivo?.toString() ?? '',
    });
    this.enlace = new EnlaceIngesta({
      version: ctx.version,
      avisos: {
        estado: (m, c) => estadoPrograma(ctx, m, c),
        // El jugador no tiene interfaz de rechazos: quedan en el log y en el diagnóstico.
        dialogo: (t, m) => {
          const texto = `${t}: ${m.replace(/\n+/g, ' ')}`;
          log(texto);
          this.diag.registraError(texto);
        },
        log,
        autenticado: (info) => {
          if (!info.porGrupo && this.traductor.matchId !== '') {
            void ctx.recuerdos.guardaMatchId(this.traductor.matchId).catch((e) => error('guardando el matchId', e));
          }
          this.arrancaBucle();
          this.camara.alCambiarConexion(true);
        },
        camara: (carga) => this.camara.recibeConfig(carga),
        desconectado: () => {
          this.paraBucle();
          this.traductor.reinicia();
          this.camara.alCambiarConexion(false);
        },
      },
    });
  }

  get camaraActiva(): boolean {
    return this.camaraEncendida;
  }

  /** Quién recibe los avisos al jugador (se pone al arrancar la app). */
  fijaAvisos(avisos: AvisosJugador): void {
    this.avisos = avisos;
  }

  /** El estado de GEP (lo crea `principal.ts`); `null` si este Electron no trae la API de Overwolf. */
  enlazaGep(gep: EstadoGep | null): void {
    this.gep = gep;
    this.refrescaEstado();
  }

  /** Manda un paquete de datos por la conexión del jugador y lo cuenta para el diagnóstico. */
  private manda(tipo: string, dato: unknown): boolean {
    const ok = this.enlace.enviaJugador(tipo, dato);
    if (ok) this.diag.cuentaEnvio(tipo);
    return ok;
  }

  /** El nombre con TAG: el de GEP si lo trae, y si no el del cliente de Riot. */
  private nombreCompleto(): string {
    return this.traductor.nombre.includes('#') ? this.traductor.nombre : this.riotId || this.traductor.nombre;
  }

  private leeRiotId(): void {
    void leeRiotIdLocal().then((id) => {
      if (id === '' || id === this.riotId) return;
      this.riotId = id;
      log(`Riot ID del cliente de Riot: ${id}`);
      this.camara.reevalua();
    });
  }

  /** El botón de la cámara. Devuelve cómo queda. */
  alternaCamara(): boolean {
    this.camaraEncendida = !this.camaraEncendida;
    log(`cámara ${this.camaraEncendida ? 'encendida' : 'apagada'} por el jugador`);
    this.camara.reevalua();
    return this.camaraEncendida;
  }

  /* ── Diagnóstico ────────────────────────────────────────────────────────── */

  /** Pasa al diagnóstico lo que sólo se sabe preguntando a las demás piezas. */
  private refrescaEstado(): void {
    const g = this.gep;
    this.diag.fijaGep(g === null ? 'sin-api' : g.caido ? 'caido' : g.listo ? 'listo' : 'esperando', g?.version ?? '');
    this.diag.fijaJuegoDetectado(g?.detectado === true);
    const c = this.camara.estado();
    this.diag.fijaCamara({ permitida: c.permitida, publicando: c.enDirecto, error: c.error });
    const puuid = this.fuente.actual();
    const base =
      puuid === ''
        ? 'not signed in to the Riot Client (or it is closed)'
        : this.riotId !== ''
          ? `signed in as ${this.riotId}`
          : 'player ID known';
    this.diag.fijaRiot(this.estadoSala !== '' ? `${base} — ${this.estadoSala}` : base, puuid !== '');
  }

  private estadoDatos(): CargaDiagnostico['datos'] {
    return this.enlace.autenticado ? 'conectada' : this.enlace.abierto ? 'conectando' : 'cerrada';
  }

  private redActual(): EstadoRed {
    return (
      this.presencia?.estadoRed() ?? { conectada: false, desdeMs: 0, conectoAlgunaVez: false, latiendo: false, oidoPorServidor: false, ultimoFallo: '', intentos: 0 }
    );
  }

  /** Lo que va en cada latido de presencia. */
  private instantanea(): CargaDiagnostico {
    this.refrescaEstado();
    return this.diag.instantanea(this.estadoDatos());
  }

  /** Todo lo que enseña la ventana (y el menú de la bandeja). */
  estadoUI(): EstadoJugadorUI {
    this.refrescaEstado();
    const red = this.redActual();
    return {
      diag: this.diag.instantanea(this.estadoDatos()),
      red,
      alertas: this.diag.alertas(red),
      historial: this.historial.slice(-8),
      version: this.ctx.version,
      jugador: this.nombreCompleto(),
      pruebaRed: this.pruebaRed,
      reglaFirewall: this.reglaFirewall,
      probandoRed: this.probandoRed,
    };
  }

  /** Texto plano para pegar en un mensaje al operador. */
  textoDiagnostico(): string {
    this.refrescaEstado();
    return this.diag.texto(this.redActual());
  }

  /** Revisa las alertas, avisa de las nuevas y mantiene al día el icono de la bandeja. */
  private evalua(): void {
    this.refrescaEstado();
    const alertas = this.diag.alertas(this.redActual());
    const ahora = Date.now();
    const activas = new Set(alertas.map((a) => a.id));
    for (const id of [...this.avisadas.keys()]) {
      if (activas.has(id)) continue;
      this.avisadas.delete(id);
      const h = [...this.historial].reverse().find((x) => x.id === id && x.hasta === null);
      if (h !== undefined) h.hasta = ahora;
    }
    for (const a of alertas) {
      const antes = this.avisadas.get(a.id);
      if (antes !== undefined && ahora - antes < RENOTIFICA_MS) continue;
      if (antes === undefined) {
        this.historial.push({ id: a.id, titulo: a.titulo, nivel: a.nivel, desde: ahora, hasta: null });
        if (this.historial.length > 30) this.historial.shift();
      }
      this.avisadas.set(a.id, ahora);
      log(`ALERTA [${a.nivel}] ${a.titulo}: ${a.detalle}`);
      try {
        this.avisos?.notifica(a);
      } catch (e) {
        error('mostrando la alerta', e);
      }
    }
    this.decideInformeAutomatico(alertas, ahora);

    const firma = alertas.map((a) => a.id).join(',');
    if (firma !== this.firmaAlertas) {
      this.firmaAlertas = firma;
      this.avisos?.alCambiar(alertas);
    }
  }

  /**
   * El informe completo se manda SOLO, una vez por sesión, cuando se ve que algo no va y nadie ha tenido que
   * pedirlo: lleva más de un minuto en partida sin recibir la vida, o tiene un problema grave sostenido.
   * Así, el operador tiene la causa a la vista sin esperar a que un jugador avise.
   */
  private informeAutomaticoEnviado = false;
  private errorDesde: number | null = null;
  private decideInformeAutomatico(alertas: Alerta[], ahora: number): void {
    if (this.informeAutomaticoEnviado || this.presencia === null) return;
    const k = this.grabadora.instantanea().porClave;
    const empiezaPartida = Math.min(k.kills?.primero ?? Infinity, k.round_phase?.primero ?? Infinity, k.scoreboard_N?.primero ?? Infinity);
    const sinVida = Number.isFinite(empiezaPartida) && ahora - empiezaPartida > 60_000 && k.health === undefined;
    const hayError = alertas.some((a) => a.nivel === 'error');
    this.errorDesde = hayError ? (this.errorDesde ?? ahora) : null;
    const errorSostenido = this.errorDesde !== null && ahora - this.errorDesde > 120_000;
    if (!sinVida && !errorSostenido) return;
    this.informeAutomaticoEnviado = true;
    log(`informe automático: ${sinVida ? 'en partida desde hace más de un minuto sin recibir la vida' : 'problema grave sostenido'}`);
    void this.enviaInforme();
  }

  /**
   * Autoprueba de red: dónde se corta exactamente la conexión (nombre, puerto, web, WebSocket). La pide el
   * jugador desde su ventana y la lanza sola el programa cuando lleva un rato sin conectar. El resultado
   * viaja al panel (en el diagnóstico) y se guarda en el log.
   */
  async ejecutaPruebaRed(): Promise<ResultadoAutoprueba | null> {
    if (this.probandoRed || this.ctx.ingesta === null) return this.pruebaRed;
    this.probandoRed = true;
    try {
      const r = await ejecutaAutoprueba({ url: normalizaIngesta(this.ctx.ingesta) });
      this.pruebaRed = r;
      log(`autoprueba de red: ${r.resumen}${r.causa ? ` — ${r.causa.texto}` : ''}`);
      this.diag.fijaRed(r.ok ? '' : `${r.causa?.texto ?? 'network check failed'} (${consejo(r.causa?.arreglo ?? 'servidor')})`);
      this.presencia?.fijaFallo(r.ok ? '' : (r.causa?.texto ?? ''));
      this.reglaFirewall = await reglaExiste().catch(() => null);
      return r;
    } finally {
      this.probandoRed = false;
    }
  }

  /** El jugador aceptó: crea la regla del Firewall (Windows pide permisos) y repite la autoprueba. */
  async permiteFirewall(): Promise<{ ok: boolean; motivo: string }> {
    log('regla del Firewall: solicitada por el jugador');
    const r = await pideRegla(process.execPath);
    log(`regla del Firewall: ${r.ok ? 'creada' : 'no se creó'} (${r.motivo})`);
    this.reglaFirewall = r.ok ? true : await reglaExiste().catch(() => null);
    if (r.ok) void this.ejecutaPruebaRed();
    return r;
  }

  /** Sin conexión con el servidor se hace la autoprueba para dar el MOTIVO, no un «no conecta» sin más. */
  private async sondea(): Promise<void> {
    const red = this.redActual();
    if (red.conectada) {
      this.diag.fijaRed('');
      return;
    }
    if (red.desdeMs < 8_000 || this.ctx.ingesta === null) return;
    if (this.pruebaRed !== null && Date.now() - this.pruebaRed.hechaEn < 30_000) return;
    const r = await this.ejecutaPruebaRed();
    if (r === null || r.ok || this.firewallOfrecido) return;
    // El puerto no responde y no hay regla: se ofrece UNA vez crearla (el jugador decide).
    if (r.causa?.arreglo === 'firewall' && this.reglaFirewall === false && red.desdeMs >= 25_000) {
      this.firewallOfrecido = true;
      this.avisos?.ofreceFirewall?.(r.causa.texto);
    }
  }

  private vueltasJuego = 0;
  private async miraJuego(): Promise<void> {
    try {
      this.diag.fijaJuegoAbierto(await valorantAbierto());
      // Otros programas que se reparten el GEP: se mira menos a menudo (la lista de procesos es pesada).
      if (this.vueltasJuego++ % 3 === 0) {
        const otros = buscaConflictos(await todosLosProcesos(), process.pid);
        if (otros.join() !== this.conflictosVistos) {
          this.conflictosVistos = otros.join();
          if (otros.length > 0) log(`CONFLICTO: otros programas usan Overwolf a la vez: ${otros.join(', ')}`);
        }
        this.diag.fijaConflictos(otros);
      }
    } catch (e) {
      log(`no se pudo mirar si VALORANT está abierto: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ── La caja negra: el informe completo ───────────────────────────────── */

  /**
   * El informe completo de este PC: estado, lo que Overwolf entregó y lo que dice tener, el entorno, la red,
   * los conflictos y el log, con las conclusiones que se pueden afirmar. Lo pide el jugador (botón) o el
   * operador (desde el panel).
   */
  async generaInforme(): Promise<ReturnType<typeof armaInforme>> {
    this.refrescaEstado();
    const preguntaGep = async <T>(f: (() => Promise<T>) | undefined): Promise<{ valor: T | null; error: string }> => {
      if (this.gep === null || f === undefined) return { valor: null, error: 'GEP no disponible' };
      try {
        return { valor: await f(), error: '' };
      } catch (e) {
        return { valor: null, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
      }
    };
    const [entorno, features, info, procesos] = await Promise.all([
      leeEntornoDelPc(process.execPath).catch(() => null),
      preguntaGep(this.gep ? () => this.gep!.leeFeatures() : undefined),
      preguntaGep(this.gep ? () => this.gep!.leeInfo() : undefined),
      todosLosProcesos().catch(() => []),
    ]);
    const prueba = this.pruebaRed ?? (await this.ejecutaPruebaRed().catch(() => null));
    const red = this.redActual();
    const infoClaves = info.valor === null ? null : [...new Set(aplanaInfo(info.valor).map((d) => d.key.replace(/_\d+$/, '_n')))];
    return armaInforme({
      creado: Date.now(),
      version: this.ctx.version,
      perfil: this.ctx.perfil.mode,
      jugador: this.nombreCompleto(),
      diag: this.diag.instantanea(this.estadoDatos()),
      red,
      alertas: this.diag.alertas(red),
      autoprueba: prueba,
      gep: {
        version: this.gep?.version ?? '',
        features: features.valor,
        featuresError: features.error,
        infoClaves,
        infoError: info.error,
      },
      grabacion: this.grabadora.instantanea(),
      entorno,
      conflictos: buscaConflictos(procesos, process.pid),
      log: colaDelLog(150),
    });
  }

  /** Genera el informe y lo manda al servidor. `true` si el servidor lo guardó. */
  async enviaInforme(): Promise<boolean> {
    if (this.generandoInforme) return false;
    this.generandoInforme = true;
    try {
      const informe = await this.generaInforme();
      const ok = (await this.presencia?.enviaInforme(JSON.stringify(informe))) ?? false;
      log(`informe completo ${ok ? 'enviado al servidor' : 'NO se pudo enviar (sin conexión)'}: ${informe.conclusiones.map((c) => c.id).join(', ')}`);
      return ok;
    } catch (e) {
      error('generando el informe completo', e);
      return false;
    } finally {
      this.generandoInforme = false;
    }
  }

  private arrancaRelojes(): void {
    const pon = (f: () => void, ms: number) => {
      const t = setInterval(() => {
        try {
          f();
        } catch (e) {
          error('tarea periódica del jugador', e);
        }
      }, ms);
      t.unref();
      this.relojes.push(t);
    };
    this.sondeoInfo.arranca();
    pon(() => this.reentraAlGrupo(), 5_000);
    pon(() => this.evalua(), ESTADO_MS);
    pon(() => void this.miraJuego(), JUEGO_MS);
    pon(() => void this.sondea(), SONDA_MS);
    void this.miraJuego();
  }

  /** Arranque: la presencia, sin esperar a ninguna partida. */
  arranca(): void {
    if (this.ctx.ingesta === null) {
      log('perfil de jugador sin ingestIp: no hay presencia ni conexión');
      this.diag.registraError('this build has no server address configured');
      return;
    }
    this.presencia = new Presencia({
      url: this.ctx.ingesta,
      puuid: () => this.fuente.actual(),
      alLlamar: (grupo, codigo) => this.alLlamar(grupo, codigo),
      diagnostico: () => this.instantanea(),
      alPedirInforme: () => void this.enviaInforme(),
      alOrdenRemota: (accion) => this.ordenRemota(accion),
      log,
    });
    this.presencia.arranca();
    this.fuente.arranca();
    this.leeRiotId();
    this.relojRiotId = setInterval(() => this.leeRiotId(), 30_000);
    this.relojRiotId.unref();
    this.arrancaRelojes();
    if (this.fuente.actual() === '') log('presencia: aún sin puuid (se espera al cliente de Riot o a GEP)');
    log(`diagnóstico: servidor ${this.ctx.ingesta}, sonda ${urlSonda(normalizaIngesta(this.ctx.ingesta)) ?? '(sin sonda)'}`);
  }

  /** Un suceso del propio GEP (juego detectado o cerrado, privilegios, errores) para la caja negra. */
  sucesoGep(tipo: string, detalle = ''): void {
    this.grabadora.suceso(tipo, detalle);
    // VALORANT se cerró: se limpia todo lo de la partida para que al abrirlo otra vez no arrastre nada.
    if (tipo === 'game-exit') {
      log('VALORANT se cerró: se reinicia el estado de la partida');
      this.traductor.reiniciaJuego();
      this.sondeoInfo.reinicia();
      this.diag.fijaEspectador(false);
      this.diag.fijaJuegoDetectado(false);
    }
  }

  /** Lo que el operador puede pedirle al programa desde el panel (lista corta: nada que toque el PC). */
  private ordenRemota(accion: string): void {
    if (accion !== 'reconecta') return;
    log('reconexión pedida por el operador');
    this.enlace.cierra('Disconnected');
    this.presencia?.reconecta();
    // Cuando la presencia vuelve, el servidor lo llama al grupo; si ya lo sabíamos, se entra sin esperar.
    this.proximoIntentoGrupo = 0;
    this.esperaGrupoMs = ESPERA_GRUPO_MS;
  }

  procesa(dato: DatoGep, clase: 'info' | 'evento' = 'info'): void {
    this.grabadora.registra(clase, dato.key, dato.value);
    this.diag.cuentaEvento(dato.key);
    this.ejecuta(this.traductor.procesa(dato));
    this.diag.fijaEspectador(this.traductor.soyEspectador);
    if (dato.key === 'player_name') this.camara.reevalua();
  }

  private ejecuta(acciones: Accion[]): void {
    for (const a of acciones) {
      switch (a.tipo) {
        case 'envia':
          if (!this.manda(a.type, a.data) && a.reintentoMs !== undefined) {
            setTimeout(() => this.manda(a.type, a.data), a.reintentoMs);
          }
          break;
        case 'conecta':
          if (a.retardoMs) setTimeout(() => this.disparaConexion(), a.retardoMs);
          else this.disparaConexion();
          break;
        case 'persistePuuid':
          void this.ctx.recuerdos.guardaPuuid(a.puuid).catch((e) => error('guardando el puuid', e));
          this.fuente.avisaSiCambio();
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
      puuid: this.traductor.puuid || this.fuente.actual(),
      matchId,
    });
  }

  /**
   * `te_llaman`: entrar por grupo.
   *   · no se lee la sala del cliente de Riot en la PC del jugador;
   *   · el `name` del logon es el nombre de GEP; sin nombre aún (jugador en
   *     el menú), se usa el puuid;
   *   · una llamada repetida no abre otro logon si ya está conectado o
   *     entrando en ese grupo.
   */
  private alLlamar(grupo: string, codigo: string): void {
    // Se recuerda el grupo al que lo llaman (también en llamadas repetidas): si pierde la conexión, vuelve solo.
    if (this.grupoRecordado !== grupo) {
      this.grupoDesde = Date.now();
      void this.ctx.almacen.escribe('grupoJugador', { grupo, desde: this.grupoDesde }).catch((e) => error('guardando el grupo', e));
    }
    this.grupoRecordado = grupo;
    // La sala de Riot va aparte de la conexión al servidor: aunque ya esté conectado, se une.
    if (codigo !== '') void this.unirseASala(codigo);
    if (this.enlace.autenticado) {
      log('te_llaman con conexión ya autenticada: nada que hacer');
      return;
    }
    if (this.enlace.abierto && this.enlace.porGrupo === grupo) {
      log(`te_llaman repetido para ${grupo}: ya se está entrando`);
      return;
    }
    this.abreGrupo(grupo);
  }

  /** Abre la conexión a la partida del grupo. */
  private abreGrupo(grupo: string): void {
    if (this.ctx.ingesta === null) return;
    this.enlace.abre(normalizaIngesta(this.ctx.ingesta), {
      rol: 'jugador',
      nombre: this.traductor.nombre || this.fuente.actual(),
      puuid: this.fuente.actual(),
      grupo,
    });
  }

  /**
   * Si se perdió la conexión a la partida (el servidor o el observador se reiniciaron, un corte largo), el
   * jugador VUELVE a entrar al grupo solo, sin esperar a que el operador pulse «Call players» otra vez. Con
   * espera creciente (10 s … 2 min) para no martillear al servidor mientras no hay partida, y se rinde a las
   * 6 horas. Sólo para quien entró por llamada: en las partidas que entran por matchId no hay grupo.
   */
  private reentraAlGrupo(): void {
    if (this.grupoRecordado === '' || this.ctx.ingesta === null) return;
    if (Date.now() - this.grupoDesde > SEIS_HORAS_MS) {
      this.grupoRecordado = '';
      return;
    }
    if (this.enlace.autenticado) {
      this.esperaGrupoMs = ESPERA_GRUPO_MS;
      this.proximoIntentoGrupo = 0;
      return;
    }
    if (this.enlace.abierto) return; // ya entrando (o reintentando por su cuenta)
    const ahora = Date.now();
    if (ahora < this.proximoIntentoGrupo) return;
    this.proximoIntentoGrupo = ahora + this.esperaGrupoMs;
    this.esperaGrupoMs = Math.min(this.esperaGrupoMs * 2, 120_000);
    log(`se perdió la conexión a la partida: se vuelve a entrar al grupo ${this.grupoRecordado}`);
    this.abreGrupo(this.grupoRecordado);
  }

  /**
   * Entra solo en la sala personalizada de Riot con su código (API local no
   * oficial). Reintenta unos segundos: puede que el cliente de Riot o la sesión
   * aún no estén listos.
   *
   * Cada llamada COMPRUEBA si el jugador está dentro de verdad (no se fía de que
   * ya se uniera antes): si salió de la sala o lo sacaron, vuelve a entrar.
   */
  private async unirseASala(codigo: string): Promise<void> {
    if (this.uniendo) return;
    this.uniendo = true;
    try {
      for (let intento = 1; intento <= 5; intento++) {
        const r = await uneASalaPorCodigo(this.riot, codigo);
        if (r.ok) {
          if (!r.yaDentro) log(`sala de Riot ${codigo}: unido`);
          this.estadoSala = `in the lobby ${codigo}`;
          return;
        }
        log(`sala de Riot ${codigo}: no se pudo unir (intento ${intento}/5): ${r.error}`);
        this.estadoSala = `could not join the lobby ${codigo}: ${r.error}`;
        await new Promise((res) => setTimeout(res, 4000));
      }
      this.diag.registraError(`could not join the lobby ${codigo}`);
    } finally {
      this.uniendo = false;
    }
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
    if (this.relojRiotId !== null) clearInterval(this.relojRiotId);
    this.sondeoInfo.para();
    for (const t of this.relojes) clearInterval(t);
    this.relojes.length = 0;
    this.paraBucle();
    this.fuente.para();
    this.presencia?.para();
    this.camara.cierra();
    this.enlace.cierra();
  }
}
