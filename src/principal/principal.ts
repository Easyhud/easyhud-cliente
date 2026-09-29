/**
 * Punto de entrada del proceso principal: la secuencia de arranque.
 *
 *   1. directorio de datos (antes del candado: el jugador usa el suyo)
 *   2. candado de instancia única (con acuse: si la instancia que lo tiene no
 *      responde, se ofrece cerrarla; ver `sistema/instancia.ts`)
 *   3. log a fichero y captura de errores
 *   4. con la app lista: inicio con Windows, ventana, IPC, atajo del operador,
 *      comprobación de actualizaciones, GEP, aviso de Overwolf nativo,
 *      disponibilidad de eventos, presencia.
 *
 * Lo que hace cada rol está en `modo-observador.ts` y `modo-jugador.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { app, BrowserWindow, dialog, globalShortcut, Menu, shell } from 'electron';
import { Almacen } from './almacen.ts';
import { Bandeja } from './bandeja.ts';
import { creaColecciones } from './coleccion.ts';
import { dialogo, estadoPrograma, type Contexto } from './contexto.ts';
import { iniciaGep, type EstadoGep } from './gep/adaptador.ts';
import { registraIpc } from './ipc.ts';
import { ModoJugador } from './modo-jugador.ts';
import { ModoObservador } from './modo-observador.ts';
import { cargaPerfil, INGESTA_POR_DEFECTO, rolEfectivo } from './perfil.ts';
import { capturaErrores, configuraRegistro, error, log } from './registro.ts';
import { PROYECTO, rutaIcono } from './rutas.ts';
import { Recuerdos } from './secreto.ts';
import { compruebaActualizacion, URL_ULTIMA } from './sistema/actualizaciones.ts';
import { eligeDirectorioDatos } from './sistema/datos.ts';
import { compruebaEventos } from './sistema/estado-eventos.ts';
import { acusa, escribeFicha, esperaAcuse, leeFicha } from './sistema/instancia.ts';
import { buscaOverwolf, cierraProceso } from './sistema/overwolf-nativo.ts';
import { buscaRestos, cierraArbol, valorantAbierto, vivo, type Yo } from './sistema/procesos.ts';
import { creaVentanaJugador, creaVentanaObservador } from './ventanas.ts';

const desarrollo = process.argv.includes('--development');
const version = app.getVersion();

/* En desarrollo se lee el `.env` del proyecto (HDEV_KEY, EASY_INGEST…); lo que ya esté en el entorno manda. */
if (desarrollo && existsSync(join(PROYECTO, '.env'))) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(join(PROYECTO, '.env'), 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const perfil = cargaPerfil();
const rol = rolEfectivo(perfil, process.argv);

/* 1. Directorio de datos, antes del candado. */
const datos = eligeDirectorioDatos({
  rol,
  appData: app.getPath('appData'),
  forzada: process.env.EASY_DIR_DATOS,
});
app.setPath('userData', datos.carpeta);

/* 2. Instancia única. */
/** Marca de un arranque lanzado por la propia app al reiniciarse. */
const TRAS_REINICIO = '--easy-tras-reinicio';
const yo: Yo = { pid: process.pid, ejecutable: process.execPath, auxiliar: process.argv.includes('--auxiliary') };
const espera = (ms: number) => new Promise((s) => setTimeout(s, ms));
const argsReinicio = () => [...process.argv.slice(1).filter((a) => a !== TRAS_REINICIO), TRAS_REINICIO];

void pideCandado();

async function pideCandado(): Promise<void> {
  const desde = Date.now();
  let candado = app.requestSingleInstanceLock();
  // Reinicio pedido por la propia app: el proceso viejo aún está saliendo; se le espera.
  if (!candado && process.argv.includes(TRAS_REINICIO)) {
    for (let i = 0; i < 60 && !candado; i++) {
      await espera(250);
      candado = app.requestSingleInstanceLock();
    }
  }
  if (candado) {
    escribeFicha(datos.carpeta, process.pid);
    arranca();
    return;
  }
  await segundaInstancia(desde);
}

/**
 * Ya hay otra instancia con el candado. Si acusa recibo, ella se muestra y
 * avisa ("ya está abierto") y ésta se cierra. Si no acusa, está colgada o es un
 * resto invisible de antes: se ofrece cerrarla y abrir de nuevo (antes esta
 * instancia se cerraba en silencio y abrir la app "no hacía nada").
 */
async function segundaInstancia(desde: number): Promise<void> {
  const ficha = leeFicha(datos.carpeta);
  // Una instancia que acaba de arrancar puede tardar en atender: se le da más margen.
  const recien = ficha !== null && Date.now() - ficha.inicio < 30_000;
  if (await esperaAcuse(datos.carpeta, desde, recien ? 15_000 : 6_000)) {
    app.quit();
    return;
  }
  await app.whenReady();
  const pids = new Set((await buscaRestos(yo)).map((p) => p.pid));
  if (ficha !== null && ficha.pid !== process.pid && vivo(ficha.pid)) pids.add(ficha.pid);
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Easy HUD - Already running',
    message: 'Easy HUD is already running, but it is not responding.',
    detail:
      (pids.size > 0 ? `Process: ${[...pids].join(', ')}.\n\n` : '') +
      'Close it and start Easy HUD again? (If Easy HUD is still working in the middle of a broadcast, choose Cancel.)',
    buttons: pids.size > 0 ? ['Close it and restart', 'Cancel'] : ['Try again', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    app.quit();
    return;
  }
  for (const pid of pids) await cierraArbol(pid);
  await espera(800);
  app.relaunch({ args: argsReinicio() });
  app.exit(0);
}

function arranca(): void {
  /* 3. Log. */
  const fichero = configuraRegistro(join(datos.carpeta, 'logs'));
  capturaErrores();
  log(`Easy HUD ${version} — perfil ${perfil.mode}, rol ${rol}${desarrollo ? ', desarrollo' : ''}`);
  log(`datos en ${datos.carpeta} (${datos.motivo}); log en ${fichero}`);

  /* URL de ingesta efectiva. `EASY_INGEST` sólo en desarrollo (para probar contra un servidor local). */
  const deDesarrollo = desarrollo ? process.env.EASY_INGEST || null : null;
  const ingesta = deDesarrollo ?? perfil.ingestIp ?? (rol === 'observador' ? INGESTA_POR_DEFECTO : null);
  const puertoLocal = Number(process.env.EASY_PUERTO_LOCAL) || 5310;

  const almacen = new Almacen(datos.carpeta);
  let principal: BrowserWindow | null = null;
  const ctx: Contexto = {
    version,
    desarrollo,
    empaquetado: app.isPackaged,
    perfil,
    rol,
    ingesta,
    puertoLocal,
    almacen,
    recuerdos: new Recuerdos(almacen),
    claveHenrik: process.env.HDEV_KEY ?? '',
    ventana: () => principal,
  };
  if (ctx.claveHenrik === '') log('sin HDEV_KEY: el respaldo de rangos por HenrikDev queda desactivado');

  const observador = rol === 'observador' ? new ModoObservador(ctx) : null;
  const jugador = rol === 'jugador' ? new ModoJugador(ctx) : null;

  let saliendo = false;
  const sal = () => {
    saliendo = true;
    app.quit();
  };
  const muestra = () => {
    if (principal === null || principal.isDestroyed()) return;
    if (principal.isMinimized()) principal.restore();
    principal.show();
    principal.focus();
  };
  const bandeja = new Bandeja(rutaIcono(app.isPackaged), muestra, sal);
  /** Reinicia la app entera (la instancia nueva espera a que ésta suelte el candado). */
  const reinicia = () => {
    log('reinicio de Easy HUD pedido por el usuario');
    app.relaunch({ args: argsReinicio() });
    sal();
  };

  /* "Ya lo tienes abierto": se acusa recibo en el acto (la segunda instancia lo
     espera para saber que ésta responde), se trae la ventana y se avisa. */
  let avisandoAbierto = false;
  const avisaYaAbierto = () => {
    muestra();
    if (avisandoAbierto) return;
    avisandoAbierto = true;
    const opciones = {
      type: 'info' as const,
      title: 'Easy HUD',
      message: 'Easy HUD is already open.',
      detail:
        rol === 'jugador'
          ? 'It keeps running in the system tray (next to the clock). There is no need to open it again.'
          : bandeja.existe
            ? 'This is the window that was already open (closing it hides it to the system tray).'
            : 'This is the window that was already open.',
      buttons: ['OK'],
    };
    const v = principal;
    void (v && !v.isDestroyed() ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones)).finally(() => {
      avisandoAbierto = false;
    });
  };

  app.on('second-instance', (_e, argv) => {
    acusa(datos.carpeta);
    log('se intentó abrir Easy HUD otra vez: se trae la ventana y se avisa');
    void app.whenReady().then(avisaYaAbierto);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let gep: EstadoGep | null = null;
  app.on('will-quit', () => {
    gep?.para();
    globalShortcut.unregisterAll();
    void observador?.apaga();
    jugador?.apaga();
  });

  void app.whenReady().then(async () => {
    /* 4.1–4.2 Inicio con Windows. */
    const inicio = { enabled: false, startMinimized: false, aux: false, ...almacen.lee('startupSettings') };
    if (perfil.forceAutostart) {
      inicio.enabled = true;
      inicio.startMinimized = perfil.startHidden;
      inicio.aux = perfil.mode === 'player';
    }
    if (!desarrollo) {
      app.setLoginItemSettings({
        openAtLogin: inicio.enabled === true,
        enabled: inicio.enabled === true,
        openAsHidden: inicio.enabled === true && inicio.startMinimized === true,
        args: inicio.aux === true ? ['--auxiliary'] : [],
      });
    }
    const bandejaActiva = perfil.forceTray || almacen.lee('traySetting').traySetting !== false;
    const oculto = perfil.startHidden || (inicio.enabled === true && inicio.startMinimized === true);

    /* 4.3 Ventana e IPC. */
    Menu.setApplicationMenu(desarrollo ? menuDesarrollo() : null);
    if (observador) {
      const v = creaVentanaObservador(almacen, desarrollo);
      principal = v;
      v.once('ready-to-show', () => {
        if (!oculto) v.show();
      });
      if (bandejaActiva || oculto) bandeja.asegura();
      v.on('close', (e) => {
        if (saliendo) return;
        if (bandeja.existe) {
          e.preventDefault();
          v.hide();
          return;
        }
        if (observador.enlace.autenticado) {
          e.preventDefault();
          void observador.confirmaCierre(v).then((cerrar) => {
            if (cerrar) sal();
          });
        }
      });
    } else {
      const v = creaVentanaJugador();
      principal = v;
      if (!perfil.startHidden) v.once('ready-to-show', () => v.show());
      bandeja.asegura();
      v.on('minimize', () => {
        if (bandeja.existe) v.hide();
      });
    }
    registraIpc(ctx, creaColecciones(almacen), observador, { cerrar: (v) => v.close() });

    /* 4.4 Atajo de la ventana operador. */
    if (observador && !globalShortcut.register('Control+Alt+O', () => observador.operador.alterna())) {
      log('no se pudo registrar Control+Alt+O');
    }

    /* 4.5 GEP. Cambio: se engancha ANTES de la comprobación de actualizaciones.
       Antes iba después, y esa comprobación puede tardar (8 s de plazo) o
       quedarse esperando a que el operador conteste el diálogo; si el `ready`
       de GEP salía en ese rato se perdía y la app no llegaba nunca a "Ready"
       hasta matar el proceso. Si el operador decide actualizar, se sale igual. */
    let recuperando = false;
    const recuperaGep = async (motivo: string) => {
      if (recuperando) return;
      recuperando = true;
      try {
        await ofreceRecuperarGep(ctx, motivo, reinicia);
      } finally {
        recuperando = false;
      }
    };
    let deteccionRevisada = false;
    const compruebaDeteccion = async () => {
      if (deteccionRevisada || gep === null || !gep.listo || gep.detectado) return;
      deteccionRevisada = true;
      if (!(await valorantAbierto())) return;
      error('VALORANT está abierto pero GEP no lo ha detectado en 60 s');
      estadoPrograma(ctx, 'Game Not Detected', 'warn');
      await recuperaGep('juego sin detectar');
    };
    gep = iniciaGep(app, {
      estado: (m, c) => estadoPrograma(ctx, m, c),
      listo: (versionGep) => {
        estadoPrograma(ctx, ctx.recuerdos.secretoVigente() !== '' ? 'Ready (Reconnect Available)' : 'Ready', 'info');
        setTimeout(() => principal?.setTitle(`Easy HUD | Ready (GEP: ${versionGep}, Easy HUD: ${version})`), 300);
        // VALORANT abierto pero GEP no lo ve: se deja escrito y se ofrece reiniciar (una vez por sesión).
        setTimeout(() => void compruebaDeteccion(), 60_000).unref();
      },
      // Primer aviso y luego uno de cada dos (cada ~4 min), para no insistir.
      sinListo: (motivo, intento) => {
        if (intento % 2 === 1) void recuperaGep(motivo);
      },
      info: (d) => (observador ? observador.info(d) : jugador?.procesa(d)),
      evento: (d) => (observador ? observador.evento(d) : jugador?.procesa(d)),
      versionIncompatible: (v) =>
        dialogo(
          ctx,
          'Potential GEP Version Issue',
          `GEP version ${v} detected, which does not support Valorant. Please use the shortcuts created by the installer to launch the app. Continuing will prevent Easy HUD from working.`,
          'warning',
        ),
      log,
      error,
    });

    /* 4.6 Actualizaciones (sólo perfil normal). */
    if (perfil.mode === 'normal' && (await hayQueActualizar(ctx))) {
      sal();
      return;
    }

    void avisaOverwolfNativo(ctx);
    setTimeout(() => void compruebaEventos(rol === 'jugador', log), 2500);


    /* 4.8 Presencia del jugador. */
    jugador?.arranca();
  });
}

function menuDesarrollo(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Desarrollo',
      submenu: [
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: (_i, v) => (v as BrowserWindow | undefined)?.webContents.reloadIgnoringCache() },
        { label: 'Recargar (F5)', accelerator: 'F5', click: (_i, v) => (v as BrowserWindow | undefined)?.webContents.reloadIgnoringCache() },
        { role: 'toggleDevTools' },
      ],
    },
  ]);
}

async function hayQueActualizar(ctx: Contexto): Promise<boolean> {
  const r = await compruebaActualizacion(ctx.version);
  switch (r.tipo) {
    case 'al-dia':
      log('actualizaciones: al día');
      return false;
    case 'silencio':
      log(`actualizaciones: ${r.motivo}`);
      return false;
    case 'fallo':
      log(`actualizaciones: fallo (${r.motivo})`);
      dialogo(
        ctx,
        'Easy HUD - Update Check Failed',
        'The automatic update check failed - please manually check if a new version of the client is available!',
        'warning',
      );
      return false;
    case 'nueva': {
      const opciones = {
        type: 'info' as const,
        title: 'Easy HUD - Update Available',
        message: `A new version of Easy HUD is available. Please update to the latest version.\n\nCurrent version: ${ctx.version}\nLatest version: ${r.nombre}`,
        // Cambio: se puede posponer (antes sólo había "Update" y cerrar el diálogo cerraba la app).
        buttons: ['Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
      };
      const v = ctx.ventana();
      const { response } = await (v ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones));
      if (response !== 0) return false;
      await shell.openExternal(URL_ULTIMA);
      return true;
    }
  }
}

async function avisaOverwolfNativo(ctx: Contexto): Promise<void> {
  for (const pid of await buscaOverwolf()) {
    const opciones = {
      type: 'warning' as const,
      title: 'Easy HUD - Overwolf GEP Conflict',
      message:
        'Regular Overwolf is running!\nIf you continue without stopping Overwolf, the risk of experiencing issues with game data is increased.\n\nDo you want Easy HUD to stop regular Overwolf now?',
      buttons: ['Stop Overwolf', 'Continue with added risk'],
      defaultId: 0,
      cancelId: 1,
    };
    const v = ctx.ventana();
    const { response } = await (v ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones));
    if (response !== 0) continue;
    if (!(await cierraProceso(pid))) {
      dialogo(
        ctx,
        'Easy HUD - Failed to stop Overwolf',
        "Couldn't close Overwolf for you.\nQuit it yourself from the tray icon (right-click → Exit), then open Easy HUD again.",
        'error',
      );
    }
  }
}

/**
 * GEP no arranca (o no ve el juego). Causas típicas: un proceso de Easy HUD de
 * una ejecución anterior que se quedó vivo (retiene los paquetes de Overwolf),
 * una actualización del paquete a medias, o el Overwolf de escritorio. Se
 * busca lo primero y se ofrece cerrarlo y reiniciar; todo queda en el log.
 */
async function ofreceRecuperarGep(ctx: Contexto, motivo: string, reinicia: () => void): Promise<void> {
  const restos = await buscaRestos(yo);
  const overwolf = await buscaOverwolf();
  const pids = restos.map((p) => p.pid).join(', ');
  log(`recuperación de GEP (${motivo}): ${restos.length} resto(s) de Easy HUD [${pids}], ${overwolf.length} Overwolf de escritorio`);
  const causas: string[] = [];
  if (restos.length > 0) {
    causas.push(`${restos.length} Easy HUD process(es) left over from a previous run (PID ${pids}) may be blocking it.`);
  }
  if (overwolf.length > 0) causas.push('Regular Overwolf is running, which can conflict with game events.');
  const opciones = {
    type: 'warning' as const,
    title: 'Easy HUD - Game events not ready',
    message:
      motivo === 'juego sin detectar'
        ? "VALORANT is open, but Easy HUD isn't receiving its game events."
        : "Overwolf's game events haven't started yet.",
    detail: [...causas, 'Restarting Easy HUD usually fixes it. You can also keep waiting.'].join('\n\n'),
    buttons: restos.length > 0 ? ['Close leftovers and restart', 'Keep waiting'] : ['Restart Easy HUD', 'Keep waiting'],
    defaultId: 0,
    cancelId: 1,
  };
  const v = ctx.ventana();
  const { response } = await (v && !v.isDestroyed() ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones));
  if (response !== 0) {
    log('recuperación de GEP: el usuario sigue esperando');
    return;
  }
  for (const p of restos) log(`cerrando resto ${p.pid}: ${(await cierraArbol(p.pid)) ? 'hecho' : 'falló'}`);
  reinicia();
}
