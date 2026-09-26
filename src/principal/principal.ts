/**
 * Punto de entrada del proceso principal: la secuencia de arranque
 * (especificación §1.3).
 *
 *   1. directorio de datos (antes del candado: el jugador usa el suyo)
 *   2. candado de instancia única
 *   3. log a fichero y captura de errores
 *   4. con la app lista: inicio con Windows, ventana, IPC, atajo del operador,
 *      comprobación de actualizaciones, GEP, aviso de Overwolf nativo,
 *      disponibilidad de eventos, protocolo `ps-spectra`, presencia.
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
import { iniciaGep } from './gep/adaptador.ts';
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
import { buscaOverwolf, cierraProceso } from './sistema/overwolf-nativo.ts';
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
  porDefecto: app.getPath('userData'),
  forzada: process.env.EASY_DIR_DATOS,
  tieneDatos: (c) => existsSync(join(c, 'storage')) || existsSync(join(c, 'Local Storage')),
});
app.setPath('userData', datos.carpeta);

/* 2. Instancia única. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  arranca();
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

  app.on('second-instance', (_e, argv) => {
    muestra();
    for (const a of argv) if (a.startsWith('ps-spectra://')) log(`enlace profundo recibido: ${a.slice(0, 120)}`);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
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

    /* 4.5 Actualizaciones (sólo perfil normal). Si el operador actualiza, no se inicializa Overwolf. */
    if (perfil.mode === 'normal' && (await hayQueActualizar(ctx))) {
      sal();
      return;
    }

    /* 4.6 GEP. */
    iniciaGep(app, {
      estado: (m, c) => estadoPrograma(ctx, m, c),
      listo: (versionGep) => {
        estadoPrograma(ctx, ctx.recuerdos.secretoVigente() !== '' ? 'Ready (Reconnect Available)' : 'Ready', 'info');
        setTimeout(() => principal?.setTitle(`Easy HUD | Ready (GEP: ${versionGep}, Easy HUD: ${version})`), 300);
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
    void avisaOverwolfNativo(ctx);
    setTimeout(() => void compruebaEventos(rol === 'jugador', log), 2500);

    /* 4.7 Protocolo `ps-spectra` (se conserva el registro por si easyhud.net lo enlaza).
       En desarrollo NO se registra: pisaría en el registro de Windows el del cliente instalado. */
    if (!desarrollo) app.setAsDefaultProtocolClient('ps-spectra');
    else log('desarrollo: no se registra el protocolo ps-spectra');
    for (const a of process.argv) if (a.startsWith('ps-spectra://')) log(`enlace profundo al arrancar: ${a.slice(0, 120)}`);

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
        "Failed to automatically stop Overwolf.\nPlease manually close Overwolf by right-clicking the Overwolf icon in the tray and selecting 'Exit Overwolf'.",
        'error',
      );
    }
  }
}
