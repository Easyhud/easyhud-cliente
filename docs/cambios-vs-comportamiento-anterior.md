# Cambios respecto al comportamiento del cliente anterior (0.3.3)

Este cliente es una reimplementación en sala limpia a partir de
`docs/especificacion.md`. Todo el contrato de interoperabilidad (eventos y
cargas del servidor, canales IPC del panel, claves de almacenamiento, puertos,
perfiles, nombres de artefactos, identidad de Overwolf) se mantiene al
carácter. Aquí se recoge **lo que cambia a propósito**, con la sección de la
especificación de la que sale.

## 1. Defectos corregidos (normativos)

| # | Antes | Ahora | Especificación |
|---|---|---|---|
| 1 | Tras una reconexión de socket.io el logon no se repetía; el servidor tiraba los datos y el cliente se creía conectado. | El logon (`obs_logon` / `aux_logon`) se emite en **cada** `connect` del socket, con el secreto de reconexión vigente; no se da por conectado hasta el acuse. Probado contra `servidor-v2`: tras cortar el transporte el acuse vuelve con `reconnected` y los datos siguen llegando al overlay. | §11.1.1, §12.4 |
| 2 | Se escuchaban nombres de evento que socket.io 4 no emite. | Socket: `connect`, `disconnect`, `connect_error`; gestor (`socket.io`): `reconnect_attempt`, `reconnect` (verificado en la documentación de socket.io v4). `disconnect` con `socket.active` = caída del transporte → "Reconnecting"; sin reconexión automática → "Connection Closed" o "Server Unreachable". | §11.1.2 |
| 3 | Un socket anterior no conectado podía quedarse reintentando en paralelo. | Abrir un socket nuevo cierra el anterior esté como esté y quita todos sus oyentes. | §11.1.3 |
| 4 | Un logon sin acuse no terminaba nunca. | 10 s sin acuse → "Connection Failed" y nuevo intento. | §11.1.4 |
| 5 | En `game_end` el estado "Game Ended" lo pisaba "Round N" y el panel creía seguir en partida. | "Game Ended" es el último estado de juego del fin de mapa. | §11.2.12 |
| 6 | "Call players" mandaba el puuid como `name`. | Va el `player_name` de GEP; sólo si aún no se conoce (jugador en el menú) se usa el puuid. | §11.1.5 |
| 7 | Clave de HenrikDev embebida en el binario. | Sólo `HDEV_KEY` del entorno (en desarrollo también del `.env`). Sin clave no hay respaldo. **La clave antigua debe rotarse.** | §2.6, §11.3.21 |
| 8 | "Restart to Latest" relanzaba con `--owepm-packages-url` apuntando a un dominio de terceros. | Eliminado (ni menú ni acelerador `Control+Alt+R`). | §1.4, §11.4.30 |
| 9 | Comprobación de actualizaciones contra otro propietario; un 404 molestaba. | `Easyhud/easyhud-client`; 404 (o sin releases) → log y silencio. | §8.1 |
| 10 | La guarda de identidad no cubría el build `normal`, cuyo `productName` era "Easy HUD" (riesgo de stub 0.0.0). | Los tres builds usan el `productName` de `identidad.json` y la guarda los comprueba todos, además de `package.json`. Corre en `npm start`, en los builds y en `npm test`. | §9.5, §11.5.31 |
| 11 | La copia del overlay para el servidor local se mantenía a mano y el build `normal` no la incluía (404 en todo) ni el icono. | `scripts/monta-overlay.mjs` la genera en cada build desde el mismo origen que el renderer, con la misma verificación de referencias; los tres builds la incluyen salvo el del jugador (que no la usa). | §9.3, §11.5.31–32 |
| 12 | La versión debía caer en el rango del servidor. | `0.3.4` (servidor acepta `>= 0.3.3 < 0.3.25`); lo comprueba una prueba de integración con `servidor-v2/src/version.ts`. | §3.1.2, §9.1 |

## 2. Otros defectos corregidos (recomendaciones de la §11)

- **Perfil de build**: se escribe en la salida compilada (`app/perfil.json`), no
  en el código fuente. Un build fallido ya no deja el proyecto con perfil de
  jugador u observador (§11.5.33).
- **Verificación de referencias** del montaje: además de `from '…'`, `url()` y
  `src`/`href`, cubre `import '…'`, `import('…')` con literal, `export … from`,
  `@import` de CSS, módulos en línea de los HTML y especificadores sin ruta
  relativa (que el navegador no resuelve) (§11.5.34).
- **Grupo del relevo local en mayúsculas**, igual que el del logon del
  observador (§11.1.9).
- **Renovar credenciales rehace los relevos abiertos** con el token nuevo
  (§11.1.10).
- **`open-external-link` sólo abre `https:`** (§11.1.11).
- **Reenvío al autenticar** de `map`, `game_mode` y (si la partida sigue)
  `match_start`, en lugar del reintento único a los 5 s que perdía el dato
  (§11.1.8). En el jugador se mantiene el reintento único de 1,5 s de
  `aux_abilities`/`aux_round_report`.
- **`te_llaman` repetido** no abre otro logon si ya está autenticado o entrando
  en ese grupo (§11.1.7).
- **"Call players" ya no lee la sala de Riot en la PC del jugador** (sólo
  servía para una línea de log y usaba la API gris): el logon por grupo es
  inmediato (§11.1.6).
- **Fin de mapa**: `map` es el último código de mapa de GEP (el mismo que
  recibe el servidor, `Infinity` → `Infinityy`), con la escena como reserva;
  `team` del roster acepta `startTeam` numérico o `"1"` (§11.2.14).
- **Menú principal**: vacía la caché de roster y el último marcador de rondas
  (§11.2.15).
- **Jugador**: el puuid del marcador local también se persiste, así un jugador
  nuevo aparece antes (§11.2.17).
- **Contexto de Riot**: caché de 5 minutos y sólo de aciertos; un 401/403 lo
  invalida. Antes se cacheaba el fallo para toda la sesión y los tokens
  caducaban sin renovarse (§11.3.20, §11.3.22).
- **Ventana del jugador** 750×320 (antes alto 460 con máximo 320) (§11.4.23).
- **Teclas globales**: patrón F1–F24; una tecla inválida avisa pero no deja sin
  registrar las demás; se registran sólo con conexión autenticada (antes
  robaban la tecla sin servir para nada); se registra en el log si otra
  aplicación tiene la tecla; `suspende-atajos` suelta sólo las del operador,
  no `Control+Alt+O` (§11.4.25).
- **Overwolf nativo**: se cierra el proceso por el que se preguntó (su PID), no
  siempre el primero (§11.4.27).
- **Aviso de actualización**: botones "Update" y "Later"; cerrar el diálogo ya
  no cierra la app (§11.4.28).
- **Enlace profundo en frío**: un `ps-spectra://` en la línea de órdenes al
  arrancar también se registra en el log (§11.4.29).
- **Base local**: la colección se mantiene en memoria y cada cambio se aplica
  antes de guardar; dos `create` seguidos sin esperar no pierden uno.
- **Servidor local**: si el puerto está ocupado se registra y el siguiente
  `arranca-overlay-local` lo reintenta.

## 3. Funcionalidad eliminada (marcada sin uso en la §10)

| Qué | Por qué |
|---|---|
| Canales `config-drop` / `load-config` (ficheros `.scg`) | No expuestos en el puente; nadie los usa. |
| `process-log` | Sin consumidor. |
| `set-tray-setting`, `set-startup-settings` | Sin interfaz. Los ajustes se siguen **leyendo** de `traySetting` y `startupSettings` y aplicando (perfiles con `forceTray`/`forceAutostart`). |
| `midmatch-event`, `send-toast` | No expuestos; el panel usa `/operador` del servidor. |
| `set-easy-status`, `set-input-allowed`, `set-loading-status`, `set-event-status`, `set-discord-info`, `fire-send-toast` | Nadie los escucha. El estado del programa sigue en el título de la ventana; la disponibilidad de eventos de Overwolf sólo en el log. |
| Tecla `showToast` | No hacía nada; ya no se registra (no roba la tecla). |
| "Restart to Latest" | Ver §1.8 arriba. |
| Lectura de sala en el jugador tras `te_llaman` | Ver §2 arriba. |
| Parseo de `discord-info` en el enlace profundo | Sin consumidor. Se conserva el registro del protocolo `ps-spectra` (en el programa instalado). |
| Página "Client Selection" del instalador normal | Se crean siempre los dos accesos directos (`Spectra Client` y `[Player] Spectra Client` con `--auxiliary`), que ahora sí apuntan al exe correcto (el `productName` es `Spectra Client`). |

`lockConnection` sigue en el objeto de perfil (el panel lo recibe entero),
pero nada lo usa.

## 4. Decisiones donde la especificación dejaba margen

- **Carpeta de datos del observador** (§1.2 pide confirmarla): regla en
  `src/principal/sistema/datos.ts` — `EASY_DIR_DATOS` → la de Electron si tiene
  datos → la primera heredada con datos (`spectra-client`, `Spectra Client`,
  `Easy HUD`) → la de Electron. En la máquina de desarrollo la del observador
  en uso es `%APPDATA%\spectra-client`, que coincide con la de Electron por
  `name`. Falta confirmarlo en una máquina de operador.
- **Carpeta del jugador**: se aplica a todo arranque con rol jugador (perfil
  `player` **o** `normal --auxiliary`), no sólo al perfil `player`, para que
  el acceso `[Player]` del instalador normal pueda convivir con el observador
  en la misma PC.
- **Log**: propio, sin electron-log, en `<datos>/logs/main.log` con rotación a
  `main.old.log` a los 2 MiB (mismo nombre de fichero que usaba electron-log).
- **Protocolo `ps-spectra`**: no se registra en desarrollo (pisaría en el
  registro de Windows el del cliente instalado).
- **Reconexión del jugador**: "Connected" sólo al llegar el acuse (antes, al
  reconectar el transporte).
- **Servidor inalcanzable**: el diálogo "Easy HUD server not reachable!" sale
  una vez por intento de conexión del observador, mientras socket.io sigue
  reintentando en segundo plano.
- **Región para HenrikDev**: la del propio cliente de Riot si se conoce; si no,
  la que devuelva HenrikDev para el puuid.
- **Nivel de ejecución del jugador**: `asInvoker` (el builder no admite
  `user`; es lo mismo: sin elevación).
- **`deleteAppDataOnUninstall`** se mantiene en normal y observer como en la
  especificación, aunque borra la base local al desinstalar.
- **Sin ESLint**: `tsc` estricto como única comprobación estática, para no
  añadir dependencias.
- **Icono** provisional generado por script (`build/icon.ico`).
