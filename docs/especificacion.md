# Especificación funcional del cliente de escritorio de Easy HUD (v2, reimplementación en sala limpia)

Versión del documento: 1.0 — 2026-09-26
Destinatario: el ingeniero que escribirá el cliente nuevo **sin acceso al código actual**. Sólo dispone de este documento, de los repositorios propios de Easy (`overlay/`, `cuentas/`, `servidor-v2/`) y de la documentación pública de Overwolf (ow-electron y Game Events Provider, GEP).

---

## 0. Propósito, reglas y convenciones

### 0.1 Qué es este programa

Un programa de escritorio para Windows, construido sobre **ow-electron** (la distribución de Electron de Overwolf que incluye el paquete de eventos de juego GEP). Tiene dos caras según el perfil con el que arranca:

1. **Observador** (la PC del realizador, que está como espectador en la partida personalizada de VALORANT):
   - Lee los eventos del juego vía GEP y los envía, ya normalizados, al servidor de partidas (puerto de ingesta 5100).
   - Aloja la interfaz del operador: la ventana principal **es** el panel del repositorio `overlay/panel/`, copiado dentro del programa al compilar. El panel es web pura y no habla con el sistema; lo hace un "shell" (`overlay/panel/js/shell.js`) a través de un puente expuesto por el programa.
   - Sirve el overlay de OBS en `http://localhost:5310/` y releva su conexión de datos contra el servidor, inyectando el token de la cuenta (que nunca llega al navegador).
   - Opcionalmente (beta) lee la sala personalizada del cliente de Riot local, crea la sala de torneo y "llama" a los jugadores.
   - Guarda en local la base del operador (equipos, matches, torneos).
2. **Jugador** ("auxiliar"): lo ejecuta cada jugador. No tiene interfaz; vive en la bandeja. Envía los datos que sólo ve el propio jugador (vida, cargas de habilidad, informe de daño, marcador de compañeros) y late su presencia para que el operador sepa quién tiene el programa abierto.

### 0.2 Reglas de esta especificación

- Todo lo que es **contrato de interoperabilidad** se da exacto, entre comillas invertidas: nombres de funciones/eventos de la API pública de Overwolf y claves/campos de GEP, eventos y cargas socket.io hacia el servidor, canales IPC y métodos del puente que usa el panel, rutas y puertos locales, claves de almacenamiento y su forma, banderas de línea de comandos, protocolo de enlace profundo, perfiles de compilación, nombres de artefactos y los campos de identidad de Overwolf. Deben respetarse al carácter: el panel y el overlay no se van a tocar y el servidor v2 ya está escrito contra este contrato.
- Todo lo demás (organización interna, módulos, nombres, estructura de ficheros) es libre y **no debe imitar** al cliente actual. Aquí sólo se describe el comportamiento.
- Cuando el comportamiento actual es un defecto, se describe tal cual y se señala en la sección 11 con recomendación. Salvo que se diga "normativo", el implementador decide con el responsable de producto qué se corrige.
- "Hoy" = el cliente 0.3.3 actual.

### 0.3 Glosario

| Término | Significado |
|---|---|
| GEP | Game Events Provider de Overwolf, servido como paquete `gep` dentro de ow-electron. |
| Info / evento | Las dos clases de datos de GEP: actualizaciones de información (`new-info-update`, pares clave/valor que cambian) y eventos de juego (`new-game-event`, sucesos puntuales). |
| Ingesta | Puerto 5100 del servidor de partidas. |
| Salida | Puerto 5200 del servidor de partidas (lo consumen overlay y panel). |
| groupCode / grupo | Código de la emisión, lo da la cuenta del operador (servicio `cuentas`). |
| Token de emisión | El `overlayToken` que devuelve el servicio de cuentas al iniciar sesión (formato en `servidor-v2/docs/especificacion.md` §8.3). |
| Secreto de reconexión | Cadena de 12 caracteres que el servidor devuelve al observador al crear un partido. |
| puuid / playerId | Identificador de Riot del jugador. |
| matchId | Identificador de la partida de VALORANT. |
| Shell | El script del panel que usa el puente; es el único consumidor del puente. |
| Panel | Interfaz del operador (`overlay/panel/`). |

### 0.4 Formato de los mensajes socket.io

Todos los eventos de aplicación hacia y desde el servidor llevan **un único argumento que es una cadena JSON** (no un objeto). Al recibir, el cliente convierte a texto y analiza JSON. No se usan callbacks de acuse; los acuses son eventos separados. Cliente socket.io 4.x.

---

## 1. Modelo de procesos, ventanas, bandeja, instancia única, arranque y perfiles

### 1.1 Perfiles de compilación

El comportamiento depende de un **perfil fijado en tiempo de compilación** (se "quema" en el binario, no se lee de disco en ejecución). Campos y valores exactos:

| Campo | Tipo | `normal` | `observer` | `player` |
|---|---|---|---|---|
| `mode` | `"normal"` / `"player"` / `"observer"` | `normal` | `observer` | `player` |
| `ingestIp` | texto o `null` | `null` | `http://2.24.200.205:5100` | `http://2.24.200.205:5100` |
| `lockConnection` | booleano | falso | verdadero | verdadero |
| `forceAutostart` | booleano | falso | falso | verdadero |
| `forceTray` | booleano | falso | verdadero | verdadero |
| `startHidden` | booleano | falso | falso | verdadero |

El objeto completo se entrega tal cual al panel (canal `get-build-profile`, §4). El panel sólo mira `mode` y trata como observador todo lo que no sea `player` (`overlay/panel/js/shell.js:55`). `lockConnection` hoy no lo consume nadie.

**Rol efectivo:**
- `player` → siempre jugador.
- `observer` → siempre observador.
- `normal` → jugador si se arranca con la bandera `--auxiliary`; observador en otro caso.

**URL de ingesta efectiva:** `ingestIp` del perfil; si es `null`, se usa `http://2.24.200.205:5100` como valor por defecto (en el observador; el jugador sin `ingestIp` no conecta y lo registra en el log).

**URL de salida derivada:** la de ingesta sustituyendo `:5100` (seguido de `/` o fin de cadena) por `:5200`. Ambos puertos viven en el mismo host (lo exige también el servidor, `servidor-v2/docs/especificacion.md` §1.1).

**Normalización de la URL de ingesta** antes de abrir el socket (aplica a todos los logons):
- Si ya tiene la forma esquema `http`/`https` + host + `:puerto` → se usa tal cual.
- Si contiene `:` pero no empieza por `http` → se antepone `https://`.
- En otro caso → se añade `:5100`, anteponiendo `https://` si no trae esquema.

### 1.2 Directorio de datos e instancia única

- En el perfil `player`, **antes** de pedir el candado de instancia única, el directorio de datos de usuario se cambia a `%APPDATA%\spectra-client-player`. Motivo: ambos perfiles comparten la identidad de Overwolf (§9.5), y con el mismo directorio el candado de instancia única los trataría como el mismo programa (abrir el jugador en la PC del observador enfocaría al observador). Con directorio propio conviven. **Normativo: mantener esa ruta**; cambiarla pierde la configuración (puuid guardado, etc.) de los jugadores existentes.
- Observador y `normal` usan el directorio de datos por defecto de Electron. Normativo: el v2 debe resolver al **mismo** directorio que hoy, porque ahí vive el `localStorage` del panel (sesión iniciada, atajos) y los ficheros de almacenamiento (§5). Verificarlo en una máquina con el cliente instalado antes de publicar.
- Instancia única: si otra instancia ya corre, la nueva termina de inmediato. La primera, al recibir el aviso de segunda instancia, muestra su ventana principal y procesa como enlace profundo cualquier argumento que empiece por `ps-spectra://` (§8.2).

### 1.3 Secuencia de arranque

1. (Sólo `player`) cambio del directorio de datos.
2. Candado de instancia única.
3. Inicialización del log a fichero (electron-log o equivalente) con captura de errores no controlados.
4. Cuando la app está lista:
   1. Se leen los ajustes de arranque guardados (§5.1, clave `startupSettings`). Si el perfil tiene `forceAutostart`, se imponen: arrancar con Windows = sí; arrancar oculto = `startHidden`; modo jugador = (`mode` es `player`).
   2. Se aplican como elemento de inicio de sesión de Windows: abrir al iniciar sesión y habilitado si están activados; abrir oculto si además "arrancar minimizado"; argumento `--auxiliary` si "modo jugador". **En desarrollo (`--development`) todo esto se desactiva.**
   3. Se crea la ventana principal (§1.4) y se registran los canales IPC (§4).
   4. Sólo observador: se registra el atajo global `Control+Alt+O` que muestra/oculta la ventana operador (§1.6).
   5. Comprobación de actualizaciones (§8.1). Si hay una más nueva y el usuario pulsa "Update", se abre la página de releases y la app **se cierra sin inicializar Overwolf**.
   6. Inicialización de GEP (§2.1), comprobación de Overwolf nativo (§8.4) y, 2,5 s después, comprobación de disponibilidad de eventos (§8.3).
   7. Registro del protocolo `ps-spectra` (§8.2).
   8. Sólo jugador: arranque de la presencia (§3.4).

### 1.4 Ventana principal

**Observador:**
- Sin marco nativo (la barra de título la dibuja el panel), fondo `#08080a`, título "Easy HUD", no pantalla completa, redimensionable, herramientas de desarrollo sólo en desarrollo.
- Tamaño/posición restaurados de la clave `windowState` (§5.1): ancho limitado a 750–1920, alto a 650–1080; sin estado guardado: 1300×670 centrada. Mínimo 830×650.
- Se guarda el rectángulo de la ventana al redimensionar, mover, maximizar y desmaximizar.
- Se crea oculta y se muestra al estar lista, salvo que (el perfil tenga `startHidden`) o (arranque con Windows activado y "arrancar minimizado"); en ese caso se asegura que exista la bandeja.
- Carga el panel desde disco: `renderer/panel/index.html` dentro del paquete de la app (lo monta el script de §9.3).

**Jugador:**
- 750×460 en (0,0), no redimensionable, con mínimo y máximo 750×320 (inconsistencia heredada, ver §11).
- Carga una página estática propia (sin lógica): fondo `#08080a`, texto centrado "EASY HUD / Cliente de jugador en marcha. / Puedes cerrar esta ventana: sigue funcionando desde la bandeja." En la práctica nunca se ve (arranca oculto).
- Al minimizar, si la bandeja está activa, se oculta.

**Navegación y ventanas nuevas (ambos):**
- Cualquier intento de abrir una ventana nueva se deniega; si la URL empieza por `https://` se abre en el navegador del sistema.
- Cualquier navegación de cualquier contenido web se cancela (el panel no puede salir de su documento).
- Cualquier `webview` se bloquea (se le quita el preload, se desactiva Node y se impide adjuntarlo).

**Menú de aplicación** (invisible, pero sus aceleradores funcionan):
- "Restart Options" → "Restart to Latest" (`Control+Alt+R`): relanza la app con los mismos argumentos más `--owepm-packages-url=<url>` (bandera de ow-electron para cambiar el origen de paquetes), quitando cualquier `--owepm-packages-url=` previo. La URL que se usa hoy es un dominio de terceros heredado del fork (`https://owepm.0008811.xyz/latest`). Ver §11: dudoso, se recomienda quitarlo.
- Sólo en desarrollo: "Desarrollo" con recargar ignorando caché (`CmdOrCtrl+R` y `F5`) y alternar herramientas de desarrollo.

**Título de la ventana:** cada cambio de estado de conexión (§3.6) pone el título "Easy HUD | <mensaje>". Al quedar GEP listo, 300 ms después, "Easy HUD | Ready (GEP: <versión GEP>, Easy HUD: <versión app>)".

### 1.5 Cerrar la ventana y bandeja

**Cierre (observador):**
- Si se está saliendo explícitamente (menú de bandeja "Quit" o confirmación previa) → se cierra.
- Si la bandeja está activa → se cancela el cierre y la ventana se oculta.
- Si no, y hay conexión autenticada con el servidor → diálogo nativo de aviso: título "Easy HUD", mensaje "Estás en directo", detalle "El observador está conectado y alimentando la emisión. Si cierras ahora, el overlay se queda sin datos.", botones "Cancelar" (defecto) y "Cerrar". "Cerrar" sale de la app.
- En otro caso se cierra. Con todas las ventanas cerradas la app termina (salvo macOS, irrelevante).

**Cierre (jugador):** se cierra sin preguntar (y termina la app).

**Bandeja:**
- Ajuste `traySetting` (§5.1), por defecto **verdadero**. Los perfiles con `forceTray` lo fuerzan a verdadero.
- Se crea: en el observador si la bandeja está activa o si arranca minimizado; en el jugador siempre.
- Icono: el `icon.ico` empaquetado como recurso; se prueban varias rutas y, si ninguna vale, un icono vacío. Si crear la bandeja falla, se registra y se sigue sin ella (**nunca** debe abortar la carga de la ventana). En Linux no se crea.
- Tooltip "Easy HUD". Menú: "Open Easy HUD" (muestra la ventana) y "Quit" (sale de verdad). Clic simple muestra la ventana.

### 1.6 Ventana operador (overlay encima del juego)

Sólo observador. Ventana adicional que el realizador ve encima de VALORANT (en ventana o sin bordes) y que OBS **no** captura:
- Ocupa exactamente los límites de la pantalla principal; transparente, sin marco, no redimensionable, no movible, sin minimizar/maximizar, fuera de la barra de tareas, **no enfocable**, sin sombra, siempre encima al nivel `screen-saver`, visible en todos los escritorios y sobre pantalla completa.
- Protección de contenido activada (Windows la excluye de las capturas).
- Ignora el ratón con reenvío (click-through).
- Carga `http://localhost:5310/operador/` (necesita el servidor local de §6 encendido; si no, queda en blanco).
- Se crea bajo demanda la primera vez y se reutiliza; al destruirse se olvida.
- Mostrar = sin robar el foco. Se alterna con `Control+Alt+O` o se fija con el canal `operador-overlay` (§4).

---

## 2. GEP: integración con Overwolf

### 2.1 Inicialización

- VALORANT tiene id de juego Overwolf **21640**.
- El `package.json` de la app declara el paquete de Overwolf `gep` (§9.5).
- Se escuchan del gestor de paquetes de ow-electron: `failed-to-initialize` (sólo log), `package-update-pending` (si el paquete es `gep`, estado "GEP Updating" en amarillo) y `ready`.
- Al recibir `ready` con nombre de paquete `gep` y su versión:
  - Estado "Ready (Reconnect Available)" si hay secreto de reconexión vigente (§5.1), si no "Ready" (neutro).
  - A los 300 ms: título con versiones y fin del estado "cargando".
  - Se quitan todos los oyentes previos del API de GEP y se fijan las features requeridas para 21640: **`match_info`, `me`, `game_info`** (llamada `setRequiredFeatures`). Si falla, diálogo "Potential GEP Version Issue": "GEP version <v> detected, which does not support Valorant. Please use the shortcuts created by the installer to launch the app. Continuing will prevent Easy HUD from working." (botón "Understood").
  - Se escucha `game-detected`: si el id no es 21640 se ignora; si lo es, se llama a la función `enable()` del evento y se marca GEP como habilitado; a partir de la segunda detección se pone estado "Ready".
  - Se escuchan `new-info-update` y `new-game-event`: sólo si GEP está habilitado; cada argumento de datos se procesa por separado (§2.2/§2.3); cualquier excepción al procesar uno se registra y no afecta a los demás.
  - Se escucha `error`: se registra y GEP queda **deshabilitado** hasta el siguiente `game-detected`.
- Cada objeto de datos trae `gameId`, `key` y `value` (texto; muchas veces JSON en texto). Todo lo que no sea del juego 21640 se ignora.
- **Stub 0.0.0:** si la identidad de la app no es la que Overwolf reconoce (§9.5), GEP informa versión `0.0.0` y no entrega ni un evento, sin error. Es la señal de diagnóstico.

### 2.2 Observador: actualizaciones de información

Todo lo que se envía va por `obs_data` (§3.2) como `{type, data}` más los campos de enrutado. Los valores de `type` son exactos.

| Clave GEP (`key`) | Condición / transformación | Se envía (`type` → `data`) | Efecto local |
|---|---|---|---|
| contiene `scoreboard` (p. ej. `scoreboard_0`…) | Se ignora si `value` es nulo o es `open`, `closed` o `close`. Se analiza JSON; se ignora si no trae `name`. Transformación de marcador (tabla A). | `scoreboard` → objeto marcador | Se guarda en la **caché de roster del mapa** indexada por `playerId` (último marcador visto de cada jugador). |
| contiene `roster` (`roster_0`…`roster_9`) | Se analiza JSON; se ignora si no trae `name`. Transformación de roster (tabla B). Se sustituye `rank` por el rango en caché si existe (§2.6). | `roster` → objeto roster | Si el rango no estaba en caché, se resuelve en segundo plano; cuando llega y difiere, **se reenvía el mismo roster** con el rango nuevo (una vez). |
| `kill_feed` | Nulo → ignorar. JSON. Transformación de killfeed (tabla C). | `killfeed` → objeto | — |
| `observing` | Nulo → ignorar. | `observing` → el texto tal cual (formato `Nombre #TAG`) | Marca "es observador". |
| `round_number` | Si hay valor. | — | Guarda el número de ronda actual (numérico). |
| `round_phase` | Nulo → ignorar. | `round_info` → `{roundNumber: <último round_number>, roundPhase: <valor>}` | Informa la fase al gestor de teclas (§7). Si la fase es `game_end` → fin de mapa (§2.5). Siempre, al final, estado de juego "Round <n>" (verde). |
| `match_score` | Nulo → ignorar. JSON con `team_0`, `team_1`. | `score` → el objeto analizado tal cual | Guarda el último marcador de rondas (faltantes = 0) para el fin de mapa. |
| `team` | Si vale `observer`. | — | Marca "es observador". |
| `scene` | Nulo → ignorar. | — | Guarda la escena. `CharacterSelectPersistentLevel` → dispara conexión automática (§3.1.3) y estado de juego "Agent Select" (verde). `MainMenu` → "Main Menu" (neutro) y desmarca observador. `Range` → "Practice Range" (neutro). |
| `game_mode` | Nulo → ignorar. JSON; si no trae `mode`, ignorar. | `game_mode` → el texto de `mode` (p. ej. `bomb`, `swift`) | Guarda modo y el booleano `custom`. Si no hay conexión, el envío se reintenta **una vez** a los 5 s. |
| `map` | Nulo → ignorar. El valor `Infinity` se convierte en `Infinityy` (el servidor no admite `Infinity`). | `map` → código de mapa | Guarda mapa. Si no hay conexión, reintento único a los 5 s. |
| `match_id` | Nulo → ignorar. | — | Guarda matchId (se usa en `match_start` y en el fin de mapa). |
| `player_name` | Nulo → ignorar. | — | Guarda el nombre del jugador local (sólo lo usa el perfil jugador). |
| `health`, `abilities` | — | — | Sólo log ("recibido en modo observador"). |
| `player_id`, `state`, `score`, `agent`, `match_outcome`, `pseudo_match_id`, `region`, `planted_site`, `is_pbe`, `ui_team_order_allies`, `ui_team_order_enemies` | Se ignoran. | — | — |
| cualquier otra | — | — | Log "no tratada". |

**Tabla A — marcador (`scoreboard`, también `aux_scoreboard`)**, campo enviado ← campo GEP:

| Enviado | Origen GEP | Notas |
|---|---|---|
| `name` | `name` | Parte anterior al primer ` #` (espacio + almohadilla). |
| `tagline` | `name` | Parte posterior a ` #` (puede quedar indefinido si no hay). |
| `playerId` | `player_id` | |
| `startTeam` | `team` | Tal cual (número o texto según versión de GEP). |
| `agentInternal` | `character` | |
| `isAlive` | `alive` | |
| `initialArmor` | `armor`, o `shield` si `armor` no existe | Renombrado según versión de GEP. |
| `scoreboardWeaponInternal` | `weapon` | |
| `currUltPoints` | `ult_points` | |
| `maxUltPoints` | `ult_max` | |
| `hasSpike` | `spike` | Si es booleano, tal cual; si no, verdadero sólo si vale `TX_Hud_Bomb_S`. |
| `money` | `money` | |
| `kills`, `deaths`, `assists` | `kills`, `deaths`, `assists` | |

**Tabla B — roster:**

| Enviado | Origen |
|---|---|
| `name` / `tagline` | `name` partido por ` #` (tagline `""` si falta) |
| `startTeam` | `team` |
| `agentInternal` | `character` |
| `playerId` | `player_id` |
| `position` | número tras el `_` de la clave (`roster_3` → 3) |
| `locked` | `locked` |
| `rank` | `rank` de GEP (suele ser 0 en customs), sustituido por el de §2.6 si se conoce |

**Tabla C — killfeed:**

| Enviado | Origen |
|---|---|
| `attacker` | `attacker` |
| `victim` | `victim` |
| `weaponKillfeedInternal` | `weapon` |
| `headshotKill` | `headshot` |
| `assists` | lista con los no vacíos de `assist1`, `assist2`, `assist3`, `assist4` (en ese orden) |
| `isTeamkill` | `is_victim_teammate` |

### 2.3 Observador: eventos de juego

| Evento GEP (`key`) | Se envía | Efecto local |
|---|---|---|
| `match_start` | `match_start` → matchId guardado (texto) | Estado de juego "Game Started" (verde). Re-persiste el secreto de reconexión recordado (§5.1). |
| `spike_planted` | `spike_planted` → `true` | — |
| `spike_detonated` | `spike_detonated` → `true` | — |
| `spike_defused` | `spike_defused` → `true` | — |
| `match_end` | — | Fin de conexión (§3.5). |
| `scoreboard_screen`, `kill_feed` (duplicado del info), `shop`, `planted_location` | Se ignoran. | — |
| otro | — | Log. |

### 2.4 Jugador: actualizaciones y eventos

En el perfil jugador **info y eventos entran por el mismo tratamiento**. Todo lo enviado va por `aux_data` (§3.3). Hay un indicador "soy espectador" (el jugador está en la partida como observador), que empieza falso.

| Clave | Tratamiento |
|---|---|
| contiene `scoreboard` | Nulo/`open`/`closed`/`close` → ignorar. JSON; sin `name` → ignorar. **Si `is_local`**: marcador (tabla A) con `type` = `aux_scoreboard`; se toma su `playerId` como puuid local (en memoria, sin guardar) y se envía. **Si no, y "soy espectador"**: se envía igual como `aux_scoreboard` (cualquier jugador). **Si no, y `teammate` es verdadero**: se guarda en el almacén de compañeros (tabla D) indexado por `playerId`, marcándolo como "cambiado". En otro caso nada. |
| `health` | Si no "soy espectador" y hay valor: se guarda la vida (numérica) para el bucle (§3.3). |
| `abilities` | Si no "soy espectador" y no nulo: JSON con claves `C`, `Q`, `E`, `X` → `aux_abilities` con `{grenade: C, ability_1: Q, ability_2: E, ultimate: X}`. Si no hay conexión, reintento único a los 1,5 s. |
| `round_report` | Si no "soy espectador" y no nulo: JSON → `aux_round_report` (tabla E). Reintento único a 1,5 s si no hay conexión. |
| `round_phase` | Nulo → ignorar. `end` → si el modo es `bomb` o `swift` **y** es custom, intenta conectar (§3.1.3; así un jugador que arregla su conexión entra en la ronda siguiente). `game_end` → "soy espectador" = falso, guarda el puuid (§5.1) y fin de conexión (§3.5). |
| `agent` | Si no "soy espectador" y no nulo: si contiene `Rift` → `aux_astra_targeting` con `data` = (contiene `Targeting`). Si no, si contiene `Gumshoe` → `aux_cypher_cam` con `data` = (contiene `PossessableCamera`). |
| `match_start` (evento) | Si modo `bomb`/`swift` y custom → intenta conectar **1 s después** (da tiempo al observador a mandar el matchId). |
| `map` | Guarda. |
| `game_mode` | JSON; guarda `mode` y `custom`. |
| `scene` | Guarda; `MainMenu` → "soy espectador" = falso. |
| `team` | `observer` → "soy espectador" = verdadero. |
| `observing` | "soy espectador" = verdadero. |
| `player_id` | Guarda y **persiste** el puuid (§5.1). |
| `match_id` | Guarda como matchId de la conexión. |
| `player_name` | Guarda el nombre (se usa en `aux_logon`). |
| otras (incluido `roster_*`) | Se ignoran (ver §11: hoy el roster del jugador nunca se lee). |

**Tabla D — marcador de compañero** (va agrupado en `aux_scoreboard_team`): `playerId`, `agentInternal`, `isAlive`, `initialArmor`, `scoreboardWeaponInternal`, `currUltPoints`, `maxUltPoints`, `hasSpike`, `money`, `kills`, `deaths`, `assists` — mismas reglas que la tabla A, sin `name`, `tagline` ni `startTeam`.

**Tabla E — informe de ronda** (cada campo numérico se convierte a número; no numérico = 0):

| Enviado | Origen GEP |
|---|---|
| `damage` | `damage` |
| `damageReceived` | `damage_received` |
| `hits` | `hit` |
| `headshots` | `headshot` |
| `bodyshots` | `bodyshots` |
| `legshots` | `legshots` |
| `finalHeadshot` | `final_headshot` convertido a número y luego a booleano |
| `abilityDamage` | `ability_damage` |

GEP sí entrega daño por ronda (`round_report`, feature `match_info`) y el ultimate (`abilities.X`); **no** entrega ADR acumulado. El servidor v2 guarda sólo `damage`, `damageReceived` y `headshots` y descarta `ultimate` (`servidor-v2/docs/especificacion.md` §6.14).

### 2.5 Fin de mapa (`serie-mapa-fin`) — detección local

Al llegar `round_phase` = `game_end` en el observador:
1. Se toma el último marcador de rondas (`team_0`, `team_1`) visto por `match_score`.
2. Se registra en el log el resultado.
3. **Si no es empate**, se envía al panel el evento IPC `serie-mapa-fin` con:

| Campo | Valor |
|---|---|
| `ganador` | `0` si `team_0` > `team_1`, si no `1` |
| `izq` | `team_0` |
| `der` | `team_1` |
| `map` | la **última escena** GEP (`scene`) vista, o `""` |
| `matchId` | último `match_id`, o `""` |
| `roster` | lista, desde la caché del mapa (§2.2), de `{name, tagline, team, agentInternal, kills, deaths, assists}`, con `team` = `1` si el `startTeam` es exactamente el número 1, si no `0` |

4. Se vacía la caché de roster, se desmarca "es observador" y se ejecuta el fin de conexión (§3.5).

No hay canal de estadísticas aparte: agente y K/D/A del mapa viajan sólo aquí. El panel tiene **dos** consumidores independientes del evento (`overlay/panel/js/panel.js:99` empuja la serie al servidor por el socket del operador; `overlay/panel/js/db.js:189` la persiste en el match "live"), ambos deduplicando por `matchId` (o por `map`+`izq`+`der` si falta). El cliente sólo emite; no lleva la serie.

### 2.6 Rango por puuid

Resolución del rango competitivo (tier 0–27) de un puuid, con caché en memoria para toda la sesión y deduplicación de peticiones simultáneas al mismo puuid:
1. **API local del cliente de Riot** (zona gris, ver §8.5 para cómo se obtiene el contexto): consulta `GET {pd}/mmr/v1/players/{puuid}` con las cabeceras de Riot; se toma `LatestCompetitiveUpdate.TierAfterUpdate` si es número > 0.
2. **Respaldo HenrikDev**: si no se sabe la región, `GET https://api.henrikdev.xyz/valorant/v1/by-puuid/account/{puuid}` → `data.region`; luego `GET https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/{region}/{puuid}` → `data.current_data.currenttier` (si es número). Cabecera `Authorization` = la clave de HenrikDev.
- La clave se lee de la variable de entorno `HDEV_KEY`. **Normativo para v2: sin valor por defecto embebido**; hoy hay una clave embebida en el binario que debe darse por comprometida y rotarse. Sin clave, el respaldo no se usa.
- Sin resultado → sin rango (no se cachea el fallo).
- El contexto del cliente de Riot se resuelve una vez por sesión (ver §11).

Consumidores: el roster del observador (§2.2) y la sala (§8.5).

---

## 3. Conexión con el servidor de partidas

Contrato del servidor: `servidor-v2/docs/especificacion.md` §3. Aquí, lo que hace el cliente.

### 3.1 Observador

#### 3.1.1 Cuándo conecta

- Cuando el shell entrega la sesión: canal `conecta` con (token de emisión, groupCode). El shell lo llama al entrar con permiso de emisión vigente (`overlay/panel/js/shell.js:217`). Si alguno está vacío, no se conecta (log).
- El programa **recuerda** en memoria (nunca en disco) el último token y grupo recibidos, para la reconexión automática.
- Reconexión automática por GEP: escena `CharacterSelectPersistentLevel` (§3.1.3).

#### 3.1.2 Logon (`obs_logon`)

1. Se abre un socket socket.io a la URL de ingesta normalizada con: reconexión activada, retardo 1000 ms, máximo 5000 ms, **sin verificar el certificado TLS**. Si ya había un socket conectado, antes se marca desconectado y se cierra.
2. Se emite `obs_logon` con:

| Campo | Valor |
|---|---|
| `type` | `authenticate` |
| `clientVersion` | versión de la app (hoy `0.3.3`; el servidor acepta ≥ 0.3.3 y < 0.3.25 — **normativo: la versión de v2 debe caer en ese rango** o ampliar el rango en el servidor) |
| `obsName` | el campo `c` del cuerpo del token (lo anterior al último `.`, base64url, JSON); si no se puede leer o está vacío, `Observer` |
| `key` | el token de emisión (`overlayToken` de cuentas) |
| `groupCode` | el grupo en **mayúsculas** |
| `groupSecret` | secreto de reconexión vigente (§5.1) o `""` |
| `leftTeam` | `{name: "", tricode: "", url: "", attackStart: true}` |
| `rightTeam` | `{name: "", tricode: "", url: "", attackStart: false}` |
| `toolsData` | `seriesInfo` {`needed` 1, `wonLeft` 0, `wonRight` 0, `mapInfo` []}, `seedingInfo` {`left` "", `right` ""}, `tournamentInfo` {`logoUrl` "", `backdropUrl` "", `timeoutDuration` 60}, `timeoutDuration` 60, `timeoutCounter` {`max` 2, `left` 2, `right` 2}, `sponsorInfo` {`enabled` false, `duration` 5, `sponsors` []}, `watermarkInfo` {`brandWatermark` false, `customTextEnabled` false, `customText` ""}, `playercamsInfo` {`enable` false, `identifier` "", `secret` "", `endTime` 0}, `roundWinBox` {`type` "disabled", `sponsors` []} |

Los equipos y `toolsData` son un punto de partida neutro: la configuración real la gobierna el panel en vivo por el espacio `/operador` del puerto 5200 (no pasa por el cliente).

3. Se escucha **una vez** `obs_logon_ack`. Sólo se procesa si `type` = `authenticate`:
   - `value` verdadero: estado "Connected" (verde); si `reason` no es `reconnected`, se recuerda como secreto de reconexión con caducidad a 2 h y se persiste (§5.1); conexión autenticada = sí; se activan las teclas globales (§7); se notifica "entrada no permitida" (§4.2, hoy sin consumidor).
   - `value` falso: diálogo de aviso "Easy HUD" con el mensaje amable (tabla F), estado "Connection Failed" (rojo), marcar desconectado y cerrar el socket.

**Tabla F — traducción del motivo de rechazo** (búsqueda de subcadenas en minúsculas, en este orden):

| Si el motivo contiene… | Texto mostrado |
|---|---|
| `still live`, o (`exists` y `group code`) | "There's already a live broadcast on this group code.\n\nIt's usually another observer still connected, or this one that didn't close cleanly. Close the other observer, wait about a minute for it to drop, then open again." |
| `not compatible` o `compatible with server` | "This observer version is out of date. Update Easy HUD and try again." |
| `not found` | "That match is no longer live on the server. Start it again from the observer." |
| `expired` | "Your broadcast permit has expired. Sign in again to renew it." |
| `invalid` | "The server didn't accept these credentials. Check your account and try again." |
| otro | el motivo tal cual; vacío → "Connection failed." |

El servidor v2 rechaza el token con `Invalid Key` o `Expired Key` (`servidor-v2/src/ingesta.ts:92`), que caen en las filas `invalid`/`expired`.

#### 3.1.3 Conexión automática ("disparo de conexión")

La usan GEP del observador (escena de selección de agentes) y del jugador (§2.4):
1. Si hay un socket que aún **no** está autenticado, se cierra y se marca desconectado (corta intentos colgados).
2. Si ya hay conexión autenticada, no hace nada.
3. Jugador: requiere `ingestIp` en el perfil (si no, log y nada); estado "Connecting" (amarillo) y logon de jugador por matchId (§3.3).
4. Observador: si aún no hay token recordado, no hace nada (espera al shell); si lo hay, repite §3.1.2 con token y grupo recordados (estado "Connecting").

#### 3.1.4 Envío de datos (`obs_data`)

Sólo si la conexión está autenticada **y** es de observador: se emite `obs_data` con `{obsName, groupCode, type, data}` (el `groupCode` en mayúsculas). Sin conexión, el dato se descarta (no hay cola; sólo los reintentos únicos de §2.2).

#### 3.1.5 Sala (`obs_lobby`)

Sólo observador autenticado: `obs_lobby` con `{obsName, groupCode, sala}` (§8.5). La sala `null` nunca se envía al servidor.

#### 3.1.6 "Call players" (`llamar_jugadores`)

Canal IPC `llamar-jugadores` con la lista de puuids (§4). Si no hay conexión autenticada de observador → `{ok: false, error: "No conectado como observador."}`. Si la hay: se escucha una vez `llamar_jugadores_ack`, se emite `llamar_jugadores` con `{puuids}`; al llegar el acuse → `{ok: true, avisados: <lista del acuse>}` (si no se puede analizar → `{ok: false, error: <texto del error>}`); si no llega en **5 s** → `{ok: false, error: "El servidor no respondió."}`.

### 3.2 Estados de conexión y mensajes

"Estado del programa" (título de ventana y canal `set-easy-status`) con tipo `info` (neutro), `danger` (rojo), `warn` (amarillo), `success` (verde). Mensajes exactos: "Ready", "Ready (Reconnect Available)", "GEP Updating", "Connecting", "Connected", "Connection Failed", "Server Unreachable", "Connection Closed", "Reconnecting", "Disconnected", "No Match ID".

Eventos del socket (observador y jugador por matchId):
- Cierre del socket → si antes se detectó "servidor inalcanzable": estado "Server Unreachable" + diálogo de error "Easy HUD - Error" / "Easy HUD server not reachable!"; si no, "Connection Closed". Después se marca desconectado y se cierra el socket.
- Error → si el código es `ECONNREFUSED`: estado "Server Unreachable" y se recuerda como inalcanzable; si no, "Connection Closed" (observador) o "Connection Failed" (jugador).
- Intento de reconexión del gestor → "Reconnecting".
- Reconexión lograda → sólo log (observador) o "Connected" (jugador).

Ver §11: con socket.io 4 los nombres de evento que escucha hoy el cliente para cierre y error no son los que emite la librería, y la reconexión del transporte **no** repite el logon. El v2 debe hacerlo bien (ver §11, recomendación normativa).

"Marcar desconectado": conexión autenticada = no, "entrada permitida", estado "Disconnected", se detiene el bucle del jugador, se reinicia vida enviada y almacén de compañeros, y se desactivan todas las teclas globales.

### 3.3 Jugador por matchId (`aux_logon`)

1. Nombre = último `player_name` de GEP. matchId = el último `match_id` de GEP, o el guardado en disco si no ha caducado (§5.1). Si no hay matchId → estado "No Match ID" (rojo) y no conecta.
2. Socket con las mismas opciones que §3.1.2 (cerrando el anterior si estaba conectado).
3. `aux_logon` con `{type: "aux_authenticate", clientVersion, name, matchId, playerId}` (`playerId` = puuid conocido).
4. Una vez `aux_logon_ack`; se procesa sólo si `type` = `aux_authenticate`:
   - Éxito: "Connected", autenticado, marca de jugador, "entrada no permitida", arranca el **bucle de 300 ms** y guarda el matchId en disco con marca de tiempo.
   - Rechazo: diálogo con tabla F, marcar desconectado, cerrar, "Connection Failed". (Con el servidor v1 los rechazos llegaban con `type` `authenticate` y se ignoraban; el v2 ya manda `aux_authenticate`, `servidor-v2/src/ingesta.ts:145`.)

**Envío (`aux_data`)**: si hay conexión autenticada, `{playerId, matchId, type, data}`.

**Bucle de 300 ms** mientras hay conexión:
- Si la vida actual difiere de la última enviada → `aux_health` con la vida (número).
- Si el almacén de compañeros cambió → `aux_scoreboard_team` con `data` = **texto JSON** de la lista de marcadores de compañeros (tabla D); después se vacía el almacén.

### 3.4 Presencia del jugador y `te_llaman`

Sólo jugador, desde el arranque (sin esperar a una partida):
- Socket propio a la URL de ingesta (tal cual, sin normalizar), sólo transporte WebSocket, reconexión activada. Independiente del socket de datos.
- Latido `cliente_presente` con `{puuid}` al conectar y cada **12 s**, sólo si el puuid conocido no está vacío y el socket está conectado. El puuid sale de GEP (`player_id`/marcador local) y está persistido en disco, así que un jugador que ya usó el programa lo tiene desde el menú; uno nuevo sólo tras su primera partida.
- Al recibir `te_llaman` con `{groupCode}` (texto no vacío; si no, se ignora):
  1. Se arranca una lectura de la sala del cliente de Riot local (§8.5) con periodo 1 s, **sólo para registrar** en el log si el jugador ya aparece.
  2. En cuanto llega la primera lectura (haya sala o no), si la lectura lanza, o a los **4 s** como red de seguridad — lo primero que ocurra y sólo una vez por llamada —, se detiene el lector y se hace el **logon de jugador por grupo**:
     - Mismas opciones de socket; `aux_logon` con `{type: "aux_authenticate", clientVersion, name, matchId: "", groupCode, playerId}`. Hoy `name` va con el **puuid**, no con el nombre (§11).
     - Éxito (`type` `aux_authenticate`, `value` verdadero): "Connected", autenticado, marca de jugador, arranca el bucle de 300 ms (no guarda matchId).
     - Rechazo: sólo log, marcar desconectado, "Connection Failed" (sin diálogo).
     - Cierre: marcar desconectado. Error: sólo log.
  3. Cuando después empieza la partida, el `match_start` del jugador intenta conectar pero ya está autenticado y no hace nada; los datos siguen por la conexión abierta.

### 3.5 Fin de conexión

Al `game_end` (observador y jugador) y al evento `match_end` (observador): si hay conexión autenticada, se cierra y se marca desconectado; estado "Connection Closed" y estado de juego "Game Ended". El mapa siguiente reconecta solo (§3.1.3); el observador usa su secreto de reconexión si el partido sigue vivo.

Al salir de la app no se envía nada al servidor.

### 3.6 Secreto de reconexión

- Se recuerda al autenticar (salvo `reconnected`) con caducidad **2 h** y se persiste (§5.1, `matchSecret`). En cada `match_start` se vuelve a persistir.
- Se lee al conectar: si ha caducado se borra y se usa `""`.

---

## 4. IPC entre el programa y el panel

### 4.1 Puente expuesto a la página (contrato normativo)

El preload expone en la página un objeto global **`window.electronAPI`** con aislamiento de contexto y **sin** canal genérico (cada método es un canal concreto). El shell llama exactamente estos métodos (`overlay/panel/js/shell.js`); nombres y firmas deben mantenerse:

| Método del puente | Canal IPC | Tipo | Argumentos → respuesta | Semántica |
|---|---|---|---|---|
| `getBuildProfile()` | `get-build-profile` | síncrono | → objeto perfil (§1.1) | Lectura antes de pintar. |
| `getObsUrl()` | `get-obs-url` | síncrono | → `http://localhost:5310/` | Dirección a poner en OBS; la decide el programa. |
| `conecta(token, grupo)` | `conecta` | envío | textos | Conectar el observador (§3.1). |
| `arrancaOverlayLocal(token, grupo)` | `arranca-overlay-local` | envío | textos | Arranca o actualiza el servidor local (§6). |
| `paraOverlayLocal()` | `para-overlay-local` | envío | — | Detiene el servidor local. |
| `arrancaLectorSala()` | `arranca-lector-sala` | envío | — | Lector de sala cada 1 s (§8.5). Ignorado en jugador. |
| `paraLectorSala()` | `para-lector-sala` | envío | — | Detiene el lector. |
| `onSalaLocal(cb)` | `sala-local` (programa→página) | suscripción | `cb(sala o null)` | Cada lectura nueva de la sala (§8.5). |
| `onEscena(cb)` | `set-game-status` (programa→página) | suscripción | `cb(<message>)` | Recibe `{message, statusType}` y entrega sólo `message` (o `""`). |
| `onSerieFin(cb)` | `serie-mapa-fin` (programa→página) | suscripción | `cb(datos)` | Fin de mapa (§2.5). |
| `creaSalaTorneo()` | `crea-sala` | invocación | → `{ok, codigo?, error?}` | §8.6. En jugador: `{ok: false, error: "Solo el observador crea la sala."}`. |
| `llamaJugadores(puuids)` | `llamar-jugadores` | invocación | lista → `{ok, avisados?, error?}` | §3.1.6. En jugador: `{ok: false, error: "Solo el observador llama a los jugadores."}`. Lista nula = vacía. |
| `dbTeamsList()` / `dbMatchesList()` / `dbTournamentsList()` | `db:teams:list` / `db:matches:list` / `db:tournaments:list` | invocación | → `{ok: true, items}` | §5.2. |
| `dbTeamsCreate(dato)` / `dbMatchesCreate` / `dbTournamentsCreate` | `db:<col>:create` | invocación | objeto → `{ok: true, item}` | |
| `dbTeamsUpdate(id, parche)` / … | `db:<col>:update` | invocación | → `{ok: true, item}` o `{ok: false, error: "No existe."}` | |
| `dbTeamsDelete(id)` / … | `db:<col>:delete` | invocación | → `{ok: <borró algo>}` | |
| `aplicaAtajos(hotkeys)` | `aplica-atajos` | envío | objeto atajos (§7) | Re-registra en caliente. |
| `suspendeAtajos()` | `suspende-atajos` | envío | — | Suelta todos los atajos (mientras el panel captura una tecla). |
| `operadorOverlay(mostrar)` | `operador-overlay` | envío | booleano | Muestra (sin foco) u oculta la ventana operador (§1.6). |
| `ventanaMinimizar()` / `ventanaMaximizar()` / `ventanaCerrar()` | `ventana-minimizar` / `ventana-maximizar` / `ventana-cerrar` | envío | — | Minimizar; maximizar/desmaximizar (alterna); cerrar (sigue §1.5). |
| `openExternalLink(url)` | `open-external-link` | envío | texto | Abre en el navegador del sistema (hoy sin validar la URL, ver §11). |

En los canales `db:*` cualquier excepción se devuelve como `{ok: false, error: <mensaje>}`; nunca se lanza al llamador. `<col>` es `teams`, `matches` o `tournaments`.

El shell construye encima los globales que usa el panel (no son del programa, pero dependen del puente): `window.__easyDB` (`shell.js:131`), `window.__easyCreaSala` (`shell.js:104`), `window.__easyLlamaJugadores` (`shell.js:110`), `window.__easyEquiposMatch` (`shell.js:119`).

### 4.2 Canales que existen hoy pero no están en el puente

**Página → programa (registrados, inalcanzables desde la página):**

| Canal | Carga | Efecto actual |
|---|---|---|
| `config-drop` | ruta de fichero | Acepta sólo `.scg`; rechaza si hay conexión; analiza JSON; exige `groupCode`, `ingestIp`, `leftTeam`, `rightTeam`; si vale, envía `load-config` a la página con el objeto; errores en diálogo. |
| `process-log` | texto | Lo escribe en el log. |
| `set-tray-setting` | booleano | Guarda `traySetting` y crea/destruye la bandeja. |
| `set-startup-settings` | `enabled`, `startMinimized`, `aux` | Guarda `startupSettings` y reaplica el inicio con Windows. |
| `midmatch-event` | tipo (texto) | Envía por `obs_data` `{type: <tipo>, data: true}` (p. ej. `swap_left_right`, `swap_attacker_defender`). |
| `send-toast` | objeto rótulo | Envía por `obs_data` `{type: "toast", data: <objeto>}`. |

**Programa → página (enviados, nadie los escucha):** `set-easy-status` `{message, statusType}`, `set-input-allowed` (booleano), `set-loading-status` (booleano), `set-event-status` (número 0–4, §8.3), `set-discord-info` `{userId, username, avatarHash}`, `load-config` (objeto), `fire-send-toast` (sin carga).

Recomendación: no reimplementarlos salvo `set-easy-status` si se quiere exponer el estado al panel (añadiendo método al puente de forma coordinada con el overlay).

---

## 5. Almacenamiento local

### 5.1 Claves de configuración

Almacenamiento clave→fichero JSON (hoy electron-json-storage con la ruta por defecto: carpeta `storage` dentro del directorio de datos de usuario, un fichero `<clave>.json` por clave). **Normativo: mismas claves, misma forma y misma ubicación**, para no perder datos de instalaciones existentes. Una clave inexistente se lee como vacía.

| Clave | Forma | Uso |
|---|---|---|
| `traySetting` | `{traySetting: booleano}` | Bandeja activa. Ausente = verdadero. |
| `windowState` | `{bounds: {x, y, width, height}}` | Sólo observador. |
| `startupSettings` | `{enabled, startMinimized, aux}` (booleanos) | Inicio con Windows. Ausente = todo falso. |
| `matchSecret` | `{secret: texto, endTime: ms}` | Secreto de reconexión; caducado = se borra al leer. |
| `playerId` | `{playerId: texto}` | puuid del jugador (se lee al arrancar). |
| `matchId` | `{matchId: texto, timestamp: ms}` | Último matchId del jugador; válido 2 h. |
| `db-teams`, `db-matches`, `db-tournaments` | `{items: [...]}` | §5.2. |

Además, el panel guarda en el `localStorage` de la ventana (propiedad del panel, pero depende de que el directorio de datos no cambie): `easy.sesion`, `easy.emision`, `easy.grupo` (sesión de cuenta), `hotkeys` (atajos), `easy.operadorOverlay`, `easy.henrikKey`, `easy.henrikRegion`, `easy.foto`, `easy.sbColapsado`.

### 5.2 Base local del operador (CRUD)

Tres colecciones: `db-teams`, `db-matches`, `db-tournaments`. Cada una se guarda como `{items: [...]}` en su clave.

- **list**: todos los registros en orden de creación.
- **create**: copia superficial del dato + `id` (UUID aleatorio), `createdAt` y `updatedAt` (ms, iguales). Se añade al final y se guarda. Devuelve el registro.
- **update(id, parche)**: mezcla superficial sobre el existente; `id` y `createdAt` no se pueden pisar; `updatedAt` = ahora. Inexistente → nulo (el canal responde "No existe.").
- **delete(id)**: filtra y guarda; devuelve si borró algo.
- Lectura síncrona, escritura esperando a que termine el guardado. Sin validación de esquema: el programa guarda lo que manda el panel.

Forma que escribe hoy el panel (informativo; la define `overlay/panel/js/db.js`):
- Equipo: `name`, `tricode`, `logoUrl`, `color` (hex opcional), `players` [{`puuid`, `name`, `tag`, `cardUrl`, `rango`, `rangoIconUrl`}] (`db.js:547-553`, `:740-747`).
- Torneo: `name`, `logoUrl`, `backdropUrl` (`db.js:773-777`).
- Match: `name`, `formato` (p. ej. `BO1`/`BO3`), `needed`, `teamAId`, `teamBId`, `teamASnap`/`teamBSnap` {`name`, `tricode`, `logoUrl`}, `tournamentId` (o nulo), `score` {`wonLeft`, `wonRight`}, `mapInfo` (lista), `estado` (`draft`/`live`/`done`) (`db.js:804-828`, `:902-914`).

---

## 6. Servidor local del overlay (puerto 5310)

Sólo observador; lo encienden y apagan los canales `arranca-overlay-local` / `para-overlay-local`.

### 6.1 Arranque

- Parámetros: raíz de ficheros del overlay, y credenciales {endpoint = URL de salida derivada (§1.1), token de emisión, grupo (tal cual lo manda el shell)}.
- Raíz: empaquetado, el recurso `overlay` junto al ejecutable (`resources/overlay`); en desarrollo, la copia del overlay dentro del proyecto del cliente.
- Escucha en **127.0.0.1:5310**. La URL publicada es `http://localhost:5310/`.
- **Idempotente**: si ya está en marcha, sólo sustituye las credenciales en memoria (las conexiones de relevo ya abiertas siguen con las anteriores).
- Las credenciales viven sólo en RAM; nunca en disco, nunca hacia la página ni en URLs.
- Errores del servidor (p. ej. puerto ocupado) sólo se registran.
- Parada: cierra socket.io y HTTP y olvida las credenciales.

### 6.2 Ficheros estáticos

- Ruta de la petición decodificada; si termina en `/`, se añade `index.html`.
- Se resuelve dentro de la raíz; si queda fuera → **403** `forbidden`.
- Si no se puede leer → **404** `not found`.
- 200 con `Cache-Control: no-store` y tipo por extensión: `.html` `text/html; charset=utf-8`; `.js`/`.mjs` `text/javascript; charset=utf-8`; `.css` `text/css; charset=utf-8`; `.json` `application/json; charset=utf-8`; `.svg` `image/svg+xml`; `.png` `image/png`; `.jpg`/`.jpeg` `image/jpeg`; `.webp` `image/webp`; `.woff2` `font/woff2`; `.woff` `font/woff`; `.mp4` `video/mp4`; `.webm` `video/webm`; `.ico` `image/x-icon`; otro `application/octet-stream`.

Lo que se sirve es el repositorio `overlay/` entero (director `/`, escenas, `operador/`, `binds/`, `panel/`, `comun/`, fuentes, iconos). El director detecta que corre en `localhost`/`127.0.0.1` y conecta su socket al mismo origen (`overlay/comun/fuente.js:44-46`, `:175`).

### 6.3 Relevo de datos (socket.io en el mismo puerto)

- CORS limitado a orígenes `http(s)://localhost` o `http(s)://127.0.0.1` con cualquier puerto.
- Por cada overlay que se conecta:
  - Sin credenciales → se le emite `logon_denied` `{reason: "sin sesión en el programa"}` y se le desconecta.
  - Con credenciales → se abre un socket "hacia arriba" contra el endpoint de salida (sólo WebSocket, reconexión 1000–5000 ms). Al conectar arriba, se emite `logon` `{groupCode, token}`.
  - Se reenvían al overlay, tal cual, `match_data`, `logon_success` y `logon_denied` recibidos de arriba. **No** se reenvía `sala` ni el espacio `/operador`.
  - Error de conexión arriba → al overlay `logon_denied` `{reason: "el programa no llega al servidor"}` (en cada intento fallido).
  - Lo que el overlay mande en su propio `logon` se **ignora**: la credencial la pone el programa.
  - Si el overlay se desconecta, se cierra su socket de arriba.

---

## 7. Teclas globales

### 7.1 Carga y registro

Objeto que manda el panel por `aplica-atajos` (lo produce `overlay/panel/js/atajos.js`, clave `hotkeys` de su localStorage):

| Campo | Defecto del panel | Acción | Se envía por `obs_data` |
|---|---|---|---|
| `spikePlanted` | `F1` | Fuerza "spike plantada" **sólo si la fase actual es `combat`** | `spike_planted` → `true` |
| `techPause` | `F2` | Pausa técnica (interruptor en el servidor) | `tech_pause` → `true` |
| `leftTimeout` | `F3` | Tiempo muerto izquierda | `left_timeout` → `true` |
| `rightTimeout` | `F4` | Tiempo muerto derecha | `right_timeout` → `true` |
| `switchKdaCredits` | `F5` | Alterna KDA/créditos | `switch_kda_credits` → `true` |
| `showToast` | `F6` | Hoy pide a la página enviar el rótulo (`fire-send-toast`), que nadie escucha | — |
| `enabled` | todos falsos | objeto con los mismos seis nombres → booleano | — |

Reglas:
- Si la carga no es un objeto o `enabled` no es un objeto → no se hace nada.
- Se sueltan primero todos los registros actuales; luego, para cada una de las seis, se asigna tecla y habilitado; al final se registran todas las habilitadas con tecla no vacía.
- Validación de tecla (sólo si está habilitada): cero o más modificadores `Ctrl+`, `Alt+`, `Shift+` seguidos de una única tecla que sea un carácter no numérico, un dígito, o `F` seguida de un dígito 1–9 opcionalmente seguido de `0` o `1`. Si una habilitada no valida → diálogo de error "Easy HUD - Error" con "The hotkey on <tecla> is invalid!" y se abandona el resto (§11: el patrón rechaza F12–F19 y admite F20/F21, etc.; el panel usa el mismo patrón).
- Las acciones sólo tienen efecto si hay conexión autenticada de observador (si no, el envío se descarta en silencio).
- Se activan también al autenticar el observador, y se desactivan todas al marcar desconectado y con `suspende-atajos`.
- La fase para `spikePlanted` es el último `round_phase` de GEP.

### 7.2 Otros atajos

- `Control+Alt+O` (global, sólo observador): alterna la ventana operador.
- `Control+Alt+R` (acelerador de menú): "Restart to Latest" (§1.4).
- En desarrollo: `CmdOrCtrl+R`, `F5`, alternar herramientas.

---

## 8. Otras funciones

### 8.1 Comprobación de actualizaciones

- Sólo en perfil `normal` (los instaladores fijos no comprueban: los sacaría del build fijo).
- `GET https://api.github.com/repos/Easyhud/easyhud-client/releases`; se toma la primera release: `tag_name` sin la `v` y `name`.
- Se comparan versiones semver con la de la app. Si alguna no es válida → aviso "Easy HUD - Update Check Failed" / "The automatic update check failed - please manually check if a new version of the client is available!" y se sigue.
- Si la release es mayor → aviso "Easy HUD - Update Available" con "A new version of Easy HUD is available. Please update to the latest version.\n\nCurrent version: <actual>\nLatest version: <name>" y un único botón "Update" → se abre `https://github.com/Easyhud/easyhud-client/releases/latest` y la app se cierra.
- Respuesta 404 (repositorio privado) → log y seguir en silencio. Otro error → el mismo aviso de fallo y seguir.

### 8.2 Enlace profundo `ps-spectra://` y Discord

- La app se registra como manejador del protocolo `ps-spectra` (en desarrollo, con la ruta del intérprete y del script).
- Sólo se procesan los enlaces que llegan por segunda instancia (§1.2). Si el enlace contiene `discord-info`, se leen los parámetros `userId`, `username` y `avatar` y se envía a la página `set-discord-info` con `{userId, username, avatarHash}`. Nadie lo consume (§10). El protocolo se mantiene por si `easyhud.net` lo enlaza (decisión registrada en `PROGRESO.md`).

### 8.3 Disponibilidad de eventos de Overwolf

2,5 s después de inicializar GEP: `GET https://game-events-status.overwolf.com/21640_prod.json`.
- `state` = 1 → nada.
- `disabled` verdadero → `set-event-status` con 4.
- Si no: estado = `state` de la feature `match_info`; en el jugador, el máximo entre ése y el de la feature `me`; se envía `set-event-status` con ese número y se registra. Valores: 0 `unsupported`, 1 `green`, 2 `yellow`, 3 `red`, 4 `disabled`.
- Errores de red: sólo log. Hoy nadie consume el canal.

### 8.4 Conflicto con Overwolf nativo

Al inicializar se buscan procesos llamados `Overwolf.exe`. Por cada uno: diálogo "Easy HUD - Overwolf GEP Conflict": "Regular Overwolf is running!\nIf you continue without stopping Overwolf, the risk of experiencing issues with game data is increased.\n\nDo you want Easy HUD to stop regular Overwolf now?" con "Stop Overwolf" / "Continue with added risk". Parar → se mata el proceso; si falla, "Easy HUD - Failed to stop Overwolf": "Failed to automatically stop Overwolf.\nPlease manually close Overwolf by right-clicking the Overwolf icon in the tray and selecting 'Exit Overwolf'.".

### 8.5 Lector de sala del cliente de Riot (beta, zona gris)

API local no oficial del cliente de Riot (la usan los medidores de rango). No está sancionada, puede romperse con cualquier parche y es zona gris de los términos de Riot; por eso va detrás de un interruptor y sólo en el observador (salvo la lectura puntual del jugador en §3.4). Sólo ve la sala en la que está este cliente y funciona mejor si el observador es el anfitrión.

**Contexto de Riot:**
1. Fichero de bloqueo en `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile`: texto separado por `:` cuyos campos 3.º, 4.º y 5.º son puerto, contraseña y protocolo. Si no existe → sin cliente de Riot.
2. `GET {protocolo}://127.0.0.1:{puerto}/entitlements/v1/token` con autenticación básica usuario `riot` y la contraseña, **sin verificar certificado** (autofirmado). Respuesta: `subject` (puuid propio), `accessToken`, `token`.
3. En `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log` se buscan la primera URL con forma `https://glz-<región>-1.<shard>.a.pvp.net` y la primera `https://pd.<shard>.a.pvp.net`. Sin `glz` → no hay sala.
4. Versión de cliente (una vez por sesión): `GET https://valorant-api.com/v1/version` → `data.riotClientVersion`.
5. Cabeceras para los servidores de Riot (que sí se verifican): `Authorization: Bearer <accessToken>`, `X-Riot-Entitlements-JWT: <token>`, `X-Riot-ClientPlatform:` base64 del JSON {`platformType` "PC", `platformOS` "Windows", `platformOSVersion` "10.0.19042.1.256.64bit", `platformChipset` "Unknown"}, `X-Riot-ClientVersion: <versión>`.
- Todas las peticiones con tiempo de espera de 4 s; un fallo equivale a "sin dato".

**Lectura de la sala:**
1. `GET {glz}/parties/v1/players/{puuid}` → `CurrentPartyID`. Sin party → nulo.
2. `GET {glz}/parties/v1/parties/{partyId}`. Si no trae `CustomGameData.Membership` → nulo (no es custom).
3. Grupos de puuids (campo `Subject` de cada entrada): `teamOne`, `teamTwo`, `teamSpectate`, `teamOneCoaches`, `teamTwoCoaches`.
4. Nombres: `PUT {pd}/name-service/v2/players` con la lista de todos los puuids → por cada `Subject`: `GameName`, `TagLine`.
5. Estados por puuid desde `Members`: `IsReady`, `IsModerator`, `UseBroadcastHUD`.
6. Rango por puuid desde la caché de §2.6; los que falten se resuelven en segundo plano (entrarán en la siguiente lectura).

**Objeto sala** (se manda por `obs_lobby` y por `sala-local`):

| Campo | Contenido |
|---|---|
| `equipoUno`, `equipoDos`, `observadores`, `coachesUno`, `coachesDos` | listas de jugadores de sala |
| `coaches` | coaches de ambos equipos (uno y luego dos) |
| `estado` | `State` de la party |
| `codigo` | `InviteCode` de la party (o `""`) |
| `mapa` | nombre visible del mapa (tabla G) |
| `modo` | `Estándar` si la ruta del modo contiene `/Bomb/`; si no, el segmento tras `GameModes/`; vacío si no hay |
| `servidor` | ciudad del `GamePod`: el texto tras `-gp-` hasta el primer no-letra; `bogota` → `Bogotá`, `santiago` → `Santiago`, `saopaulo` → `São Paulo`, `miami` → `Miami`, `chicago` → `Chicago`, `mexico` → `México`, `dallas` → `Dallas`, `atlanta` → `Atlanta`; otros con la inicial en mayúscula |
| `cerrada` | `Accessibility` es `CLOSED` |

Jugador de sala: `puuid`, `nombre` (`…` si no se resolvió), `tag`, `rango` (número o ausente), `listo`, `moderador`, `hudBroadcast` (booleanos).

**Tabla G — mapas** (último segmento de la ruta del mapa → nombre): `Ascent` → Ascent, `Duality` → Bind, `Bonsai` → Split, `Port` → Icebox, `Triad` → Haven, `Foxtrot` → Breeze, `Canyon` → Fracture, `Pitt` → Pearl, `Jam` → Lotus, `Juliett` → Sunset, `Infinity` → Abyss, `Rook` → Corrode; cualquier otro, tal cual.

**Sondeo:**
- Periodo pedido por el llamador (el observador usa 1 s; por defecto 3 s). Una lectura inmediata al arrancar.
- Se entrega una lectura si difiere de la anterior (comparando su serialización completa, incluido nulo) **o** si han pasado ~30 s desde la última entrega (latido para que reaparezca tras reinicios del servidor).
- En el observador cada entrega va a la página por `sala-local` (también el nulo, que el panel usa para saber que se salió del lobby) y, si no es nula, al servidor por `obs_lobby`.
- Arrancar con el lector ya activo no hace nada. Errores: log.

### 8.6 Crear sala de torneo (beta, escritura sobre el cliente de Riot)

Canal `crea-sala`, sólo observador. Pasos, cada uno contra `{glz}/parties/v1/parties/{partyId}`; al primer fallo se devuelve `{ok: false, error}`:

| Paso | Petición | Error devuelto |
|---|---|---|
| 0 | Contexto de Riot (§8.5) | "El cliente de Riot no está abierto." |
| 1 | `GET .../parties/v1/players/{puuid}` → party | "No hay party activa en el cliente de Riot." |
| 2 | `POST /makecustomgame` | "makecustomgame falló (<estado HTTP>)." |
| 3 | `GET` de la party para leer `CustomGameData.Settings.GamePod` actual; `POST /customgamesettings` con `Map` `/Game/Maps/Ascent/Ascent`, `Mode` `/Game/GameModes/Bomb/BombGameMode.BombGameMode_C`, `UseBots` falso, `GamePod` = el actual o, si no hay, el primero de `GET {glz}/parties/v1/parties/customgameconfigs` (`GamePodPingServiceInfo`) que contenga la región, o el primero, o `aresriot.aws-scl1-prod.latam-gp-santiago-1`; `GameRules` = {`AllowGameModifiers` "true", `PlayOutAllRounds` "false", `SkipMatchHistory` "false", `TournamentMode` "true", `IsOvertimeWinByTwo` "true"} | "customgamesettings falló (<estado>)." |
| 4 | `POST /customgamemembership/TeamSpectate` con `{playerToPutOnTeam: <puuid propio>}` | "mover a espectador falló (<estado>)." |
| 5 | `POST /accessibility` con `{accessibility: "CLOSED"}` | "cerrar sala falló (<estado>)." |
| 6 | `POST /invitecode` → `InviteCode` | "generar código falló (<estado>)." |
| — | Éxito | `{ok: true, codigo}` |

`AllowGameModifiers` va activado a propósito (permite pausar el reloj de la partida). El código sirve para entrar y también como sala de cámaras.

### 8.7 Log

Log a fichero con rotación estándar de electron-log (o equivalente) en la carpeta de logs de la app. Debe incluir: arranque y modo, versión de GEP lista, juego detectado, conexión/rechazos con motivo, "Unhandled info/game update", fin de mapa con marcador, lector de sala, errores capturados. Nunca el token completo.

---

## 9. Compilación y empaquetado

### 9.1 Versiones y dependencias de plataforma

- ow-electron **37.10.3** (Electron 37.10.3) y ow-electron-builder **26.0.12**. El paquete de Overwolf declarado: `gep`.
- Tras instalar dependencias se ejecuta la instalación de dependencias nativas del builder.
- Versión de la app: **0.3.3** (ver restricción de rango en §3.1.2).

### 9.2 Órdenes

| Orden | Qué hace |
|---|---|
| inicio en desarrollo | limpiar salida → compilar TypeScript → montar el renderer (§9.3) → lanzar ow-electron con `--development` |
| inicio jugador en desarrollo | lo mismo con `--auxiliary --development` |
| build normal | limpiar salida y `dist` → **guarda de identidad** (§9.5) → compilar → montar renderer → builder sin publicar |
| publish | igual, publicando (GitHub, borrador) |
| build observer | fijar perfil `observer` con `http://2.24.200.205:5100` → limpiar → guarda → compilar → montar → builder con la configuración del observador → **restaurar perfil `normal`** |
| build player | fijar perfil `player` con `http://2.24.200.205:5100` → … → builder con la configuración del jugador y salida `dist-player` → restaurar `normal` |
| test identidad | sólo la guarda |
| lint | ESLint sobre el código fuente |

**Fijar perfil**: un script recibe el modo (`normal` | `player` | `observer`) y opcionalmente la IP, y **regenera** el módulo fuente del perfil con los valores de §1.1 (el `ingestIp` es el argumento; `normal` siempre `null`). Modo desconocido → error y salida 1. Recompilar el jugador es obligatorio cada vez que cambie algo de su lado, porque la IP y el código quedan dentro del exe.

### 9.3 Montaje del renderer

Script de build que ensambla la interfaz del exe a partir del repositorio del overlay:
- Origen: carpeta hermana `../overlay`, o la ruta de la variable de entorno `EASY_OVERLAY` (relativa al proyecto del cliente). Si no existe → error explicando cómo indicarla, salida 1.
- Destino: `renderer/` dentro de la carpeta de salida compilada; **se borra y se rehace entero** cada vez.
- Piezas (todas obligatorias; si falta una → error y salida 1):

| Origen (en el overlay, salvo la última) | Destino en el renderer |
|---|---|
| `panel/` | `panel/` |
| `comun/vendor/` (socket.io del panel) | `comun/vendor/` |
| `fonts/` | `fonts/` |
| `fonts.css` | `fonts.css` |
| (del propio cliente) la página del jugador | `jugador.html` |

- La disposición **debe espejar** la raíz del overlay: el panel referencia `../../fonts.css` (desde `panel/css/`) y `../../comun/vendor/…` (desde `panel/js/enlace.js`). Aplanar el panel rompe el import de socket.io en silencio.
- Se elimina `panel/README.md` del destino.
- Sello de versión: se inserta antes de `</head>` en `panel/index.html` una etiqueta meta `easy-version` con contenido `<versión de la app>+<AAAA-MM-DD HH:MM>` (UTC, a partir del ISO).
- Verificación de referencias: se recorren los `.js` (importaciones estáticas `from '...'`), `.css` (`url(...)`) y `.html` (`src`/`href`); se ignoran las que empiezan por `http:`, `https:`, `data:`, `#` o `/`; se quita la consulta; si alguna no resuelve a un fichero existente se lista y el build falla (salida 1). Mensaje de éxito: `renderer montado en app/renderer (versión <sello>)`.

**La copia completa del overlay para el servidor local** (`overlay-empaquetado` en el proyecto del cliente, que se empaqueta como recurso `overlay`) **hoy no la genera ningún script**: se mantiene a mano y puede quedar desfasada respecto a `overlay/` (§11). Normativo para v2: generarla en el build desde el mismo origen que el renderer (todo el repositorio del overlay salvo `node_modules`, herramientas y documentación), con la misma verificación de referencias.

### 9.4 Salidas del empaquetador

Comunes: compresión máxima; ficheros incluidos = salida compilada, `package.json` y `LICENSE`; idiomas de Electron sólo `en-US`; icono `build/icon.ico`.

| Perfil | Configuración | Destino Windows | Artefacto | Opciones |
|---|---|---|---|---|
| normal | la del `package.json` | `nsis-web` | `EasyHUD-Client-Setup.<ext>` | no one-click, por usuario, permite elegir carpeta, `deleteAppDataOnUninstall`, no ejecutar al terminar, paquete diferencial; incluye página de instalador propia (abajo); publicación GitHub propietario `No1seh` (desfasado, hoy es `Easyhud`), auto-update, release en borrador; `productName` "Easy HUD" |
| observer | configuración del observador | `nsis` | `EasyHUD-Observer-Setup.<ext>` | no one-click, por usuario, **sin** elegir carpeta, ejecutar al terminar, `deleteAppDataOnUninstall`; recursos extra: la copia del overlay → `overlay`, `build/icon.ico` → `icon.ico` |
| player | configuración del jugador | `portable` | `EasyHUD-Player.<ext>` en `dist-player/` | nivel de ejecución `user` (sin admin), carpeta de desempaquetado `EasyHUD-Player`; recursos extra: sólo `icon.ico`; **excluye** del paquete `renderer/panel/**`, `renderer/comun/**`, `renderer/fonts/**` y `renderer/fonts.css` (el jugador sólo carga `jugador.html`) |

El exe del jugador pesa ~78 MB (runtime de Electron + GEP; no se puede bajar sin dejar Overwolf).

**Página propia del instalador normal:** "Client Selection" / "What client(s) would you like to install?" con dos casillas marcadas por defecto, "Install Observer Client" e "Install Player Client"; "Siguiente" deshabilitado si ninguna está marcada. En la instalación se borran y recrean accesos directos en el menú Inicio y el escritorio: `Spectra Client.lnk` (sin argumentos) y `[Player] Spectra Client.lnk` (con `--auxiliary`), ambos a `Spectra Client.exe` en la carpeta de instalación (ver §11: con `productName` "Easy HUD" el exe no se llama así).

Existe además un script por lotes de conveniencia que ejecuta, elevado, los builds de jugador y observador seguidos con yarn (vía corepack) y vuelca la salida a un log. El gestor de paquetes declarado es yarn 4.10.3.

### 9.5 Identidad de Overwolf (normativo, no tocar)

Overwolf sólo sirve el paquete real de GEP a identidades que reconoce, y la propia de Easy (`net.easyhud.*`) aún no está aprobada. Los builds usan la identidad prestada de ValoSpectra. Si cambia **cualquiera** de estos campos, GEP carga un stub `0.0.0`: la aplicación parece normal pero **GEP no entrega eventos** y no hay ningún mensaje de error (confirmado en vivo el 2026-09-22, ver `PROGRESO.md` §5: cambiar sólo `author` ya lo rompió, y revertirlo lo arregló con el mismo VALORANT abierto).

| Campo | Valor exacto |
|---|---|
| `package.json` → `name` | `spectra-client` |
| `package.json` → `author.name` | `Purple Shark UG (haftungsbeschränkt)` |
| `package.json` → `author.url` | `https://www.valospectra.com` |
| configuraciones del builder de observador y jugador → `productName` | `Spectra Client` |
| configuraciones del builder de observador y jugador → `appId` | **ausente** |
| `package.json` → `overwolf.packages` | `["gep"]` |

El `package.json` también lleva `description` "Easy HUD - overlays de transmision para torneos de VALORANT (easyhud.net)", `private` verdadero, licencia `GPL-3.0-only` (ver nota de licencia abajo).

**Guarda de identidad**: hoy un script de build (`scripts/comprueba-identidad.mjs` en el cliente actual) lee el `package.json` y las dos configuraciones del builder y falla el build (salida 1, listando cada discrepancia y indicando que el fallo es funcional, no estético) si `name`, `author.name`, `author.url` o algún `productName` no coinciden o si hay `appId`. Imprime `✓ identidad de GEP intacta (spectra-client / Spectra Client)` al pasar. Se ejecuta antes de compilar en todos los builds. **El v2 debe tener una guarda equivalente**, ejecutada en todos los builds y en el arranque de desarrollo, y extenderla a la configuración del build normal (§11). Cuando Easy tenga identidad aprobada, se cambian los valores esperados; la comprobación no se borra.

Nota de licencia: el v2 es una reimplementación sin código de ValoSpectra; la licencia del proyecto nuevo la decide Easy. Los campos de identidad anteriores son datos de interoperabilidad con Overwolf, no código.

---

## 10. Funcionalidad frente a uso real en Easy HUD

Rutas relativas a `D:\Trabajo\Easy  V3\`. "Sí" = hay consumidor en `overlay/panel` o en `servidor-v2`; "No" = nadie lo usa; "Dudoso" = explicado.

| Funcionalidad | ¿La usa Easy HUD? | Evidencia |
|---|---|---|
| `get-build-profile` / `getBuildProfile` | Sí | `overlay/panel/js/shell.js:43`, `:55` |
| `get-obs-url` / `getObsUrl` | Sí | `overlay/panel/js/shell.js:60`, `:222` |
| `conecta` (logon del observador) | Sí | `overlay/panel/js/shell.js:217`; `servidor-v2/src/ingesta.ts:67-130` |
| `arranca-overlay-local` / `para-overlay-local` | Sí | `overlay/panel/js/shell.js:209`, `:234` |
| Servidor local 5310 (estáticos + relevo) | Sí | `overlay/comun/fuente.js:44-46`, `:175`; `servidor-v2/src/salida.ts:51-67`, `:127` |
| Relevo de `logon_success` | Dudoso: se reenvía, nadie lo escucha | `servidor-v2/src/salida.ts:67` |
| Ventana operador + `operador-overlay` + `Control+Alt+O` | Sí | `overlay/panel/js/shell.js:97-98`, `:161-171`, `:235`; `overlay/operador/index.html:26` |
| `ventana-minimizar/maximizar/cerrar` | Sí | `overlay/panel/js/shell.js:69-71` |
| `open-external-link` | Sí | `overlay/panel/js/acceso.js:82` |
| `aplica-atajos` / `suspende-atajos` | Sí | `overlay/panel/js/shell.js:82`, `:89`, `:93`, `:213`; `overlay/panel/js/panel.js:388-422` |
| Teclas `spike_planted`, `tech_pause`, `left_timeout`, `right_timeout`, `switch_kda_credits` | Sí | `servidor-v2/src/partida/reductor.ts:140`, `:150-157` |
| Tecla `showToast` / `fire-send-toast` | No (nadie escucha el canal) | ausente en `overlay/panel/js/shell.js` |
| `set-game-status` → `onEscena` | Sí (sólo `message`; "Agent Select" y "Round N" deciden "en partida") | `overlay/panel/js/shell.js:141`; `overlay/panel/js/panel.js:80`, `:900-904`, `:1262-1263` |
| `serie-mapa-fin` → `onSerieFin` (incl. `roster`) | Sí | `overlay/panel/js/shell.js:146`; `overlay/panel/js/panel.js:99-114`; `overlay/panel/js/db.js:189-206`; `overlay/panel/js/finmapa.js` |
| Lector de sala + `sala-local` | Sí (beta) | `overlay/panel/js/shell.js:150`, `:210`, `:233`; `overlay/panel/js/panel.js:1397` |
| `obs_lobby` | Sí (beta) | `servidor-v2/src/ingesta.ts:213-220` |
| `crea-sala` | Sí (beta) | `overlay/panel/js/shell.js:104`; `overlay/panel/js/panel.js:971` |
| `llamar-jugadores` / `llamar_jugadores` / `llamar_jugadores_ack` | Sí (beta) | `overlay/panel/js/shell.js:110-114`; `overlay/panel/js/panel.js:1012`; `servidor-v2/src/ingesta.ts:222-239` |
| `cliente_presente` / `te_llaman` | Sí (beta) | `servidor-v2/src/ingesta.ts:56-63`, `:235` |
| `aux_logon` por matchId y por groupCode | Sí | `servidor-v2/src/ingesta.ts:134-169` |
| CRUD `db:*` | Sí | `overlay/panel/js/shell.js:124-135`; `overlay/panel/js/db.js:22`, `:205`, `:562`, `:780-781`, `:821-828`, `:902` |
| `obs_data`: `scoreboard`, `roster`, `killfeed`, `observing`, `round_info`, `score`, `game_mode`, `map`, `match_start`, `spike_*` | Sí | `servidor-v2/src/partida/reductor.ts:111-148` |
| Rango por puuid en `roster` | Sí | `servidor-v2/src/partida/jugadores.ts:160`, `:174` |
| `aux_data`: `aux_health`, `aux_abilities`, `aux_round_report`, `aux_scoreboard`, `aux_scoreboard_team`, `aux_astra_targeting`, `aux_cypher_cam` | Sí | `servidor-v2/src/partida/reductor.ts:173-186` |
| `aux_abilities.ultimate` | No (el servidor lo descarta) | `servidor-v2/docs/especificacion.md` §6.14 |
| `aux_round_report`: `hits`, `bodyshots`, `legshots`, `finalHeadshot`, `abilityDamage` | No (sólo se usan `damage`, `damageReceived`, `headshots`) | `servidor-v2/docs/especificacion.md` §6.14 |
| Daño por ronda en pantalla | Dudoso: se guarda en el servidor; el overlay lo pinta como desconocido | `servidor-v2/docs/especificacion.md` §12 |
| `aux_astra_targeting` / `aux_cypher_cam` (sufijo de icono) | Dudoso: se procesa, nadie pinta el sufijo | `servidor-v2/src/partida/reductor.ts:183-186`; `servidor-v2/docs/cambios-vs-comportamiento-anterior.md` §5 |
| Secreto de reconexión (`groupSecret`/`reconnected`) | Sí | `servidor-v2/src/ingesta.ts:102-104` |
| `toolsData` inicial del logon | Sí como semilla; `seedingInfo` y `roundWinBox` No | `servidor-v2/docs/cambios-vs-comportamiento-anterior.md` §5 |
| `midmatch-event` (`swap_left_right`/`swap_attacker_defender` por `obs_data`) | No (canal no expuesto; el panel usa `/operador`) | ausente en el puente; `servidor-v2/src/partida/reductor.ts:163-167` |
| `send-toast` | No (canal no expuesto) | ídem |
| `config-drop` / `load-config` (ficheros `.scg`) | No | ausente en `overlay/panel/js/` |
| `set-tray-setting`, `set-startup-settings` | No (sin UI; sólo valores por defecto/perfil) | ausente en `overlay/panel/js/` |
| `process-log` | No | ídem |
| `set-easy-status`, `set-input-allowed`, `set-loading-status`, `set-event-status` | No (sólo afectan al título de la ventana) | ídem |
| Enlace profundo `ps-spectra://` + `set-discord-info` | No (se conserva el registro del protocolo por riesgo externo) | ausente en `overlay/panel/js/`; `PROGRESO.md` §5 |
| Comprobación de actualizaciones | Dudoso: sólo perfil `normal`, el repositorio es privado y devuelve 404 | — |
| "Restart to Latest" (`--owepm-packages-url`) | Dudoso: apunta a un dominio de terceros heredado | — |
| Aviso de Overwolf nativo | Sí (protección real de GEP) | — |
| Comprobación de disponibilidad de eventos | Dudoso: sólo log | — |
| Perfil `lockConnection` | No | ausente en `overlay/panel/js/` |
| Instalador `nsis-web` con selección de clientes | Dudoso: accesos directos a un exe que no existe con ese `productName` | §9.4 |
| Consulta de rango a HenrikDev desde el programa | Sí como respaldo (el panel además consulta por su cuenta con su propia clave) | `overlay/panel/js/db.js:735-748` |

---

## 11. Defectos conocidos y recomendaciones

### 11.1 Conexión

1. **La reconexión automática no reautentica.** El logon se emite una sola vez al crear el socket y el acuse se escucha una vez. Si el transporte se cae y socket.io reconecta, el servidor ve un socket nuevo sin autenticar y descarta todos los datos, mientras el cliente sigue creyéndose conectado. **Normativo v2:** en cada evento de conexión del socket (inicial y tras reconexión) repetir el logon con el secreto de reconexión recordado, y no dar por conectado hasta el acuse.
2. **Eventos de socket mal nombrados.** Para cierre y error se escuchan nombres que socket.io 4 no emite en el socket del cliente (la librería emite `disconnect` y `connect_error`). Resultado: "Server Unreachable" y "Connection Closed" por caída casi nunca aparecen y el estado se queda en "Reconnecting". Verificar contra la documentación de socket.io 4 y usar los eventos reservados correctos.
3. Si existía un socket anterior **no conectado** (reintentando), no se cierra al abrir uno nuevo: pueden quedar sockets fantasma reintentando en paralelo con oyentes duplicados (la conexión automática lo mitiga sólo en parte).
4. Un logon del observador que no recibe acuse nunca termina (no hay tiempo de espera).
5. En "Call players" el `aux_logon` lleva el **puuid como `name`** (el nombre del jugador sí está disponible desde GEP).
6. En "Call players" la lectura de la sala del jugador sólo se registra en el log; no confirma nada y usa la API gris en la PC del jugador. Recomendación: quitarla.
7. `te_llaman` repetido puede disparar varios logons por grupo seguidos (la protección es por llamada).
8. Los reintentos de `game_mode`/`map` (5 s) y `abilities`/`round_report` (1,5 s) son únicos: si tras el retardo sigue sin conexión, el dato se pierde. `game_mode` y `map` llegan en la selección de agentes, justo cuando se está conectando. Recomendación: guardar el último valor de cada uno y reenviarlo al autenticar.
9. El grupo del relevo local se usa tal cual y el del logon del observador en mayúsculas; si la cuenta devolviera minúsculas, el overlay local y el observador irían a salas distintas.
10. El relevo local no actualiza las conexiones ya abiertas al renovar credenciales; un overlay abierto sigue con el token viejo hasta reconectar.
11. `open-external-link` abre cualquier URL que mande la página sin validar esquema. Recomendación v2: sólo `https:`.

### 11.2 GEP y datos

12. **Tras el fin de mapa el panel cree que sigue en partida.** En `game_end` se pone el estado de juego "Game Ended" y acto seguido "Round <n>" (el estado "Round" se escribe después de tratar la fase). El panel considera "en partida" cualquier escena que empiece por "Round " (`overlay/panel/js/panel.js:1263`). Recomendación: no pisar "Game Ended".
13. El número de ronda de `round_info` es el último `round_number` visto; GEP puede entregar la fase antes que el número y quedar desfasado.
14. En `serie-mapa-fin`, `map` es la última **escena**, no el último `map`; e `izq`/`der`/`ganador` son los equipos de juego 0/1, no los lados de pantalla (si el operador intercambió lados, el panel suma el mapa al equipo equivocado). `team` en el roster exige que `startTeam` sea el número 1: si GEP lo da como texto `"1"`, todos quedan en el equipo 0.
15. El último marcador de rondas no se reinicia tras el fin de mapa ni al volver al menú; la caché de roster no se vacía al volver al menú (una partida abandonada deja jugadores viejos para la siguiente).
16. Un empate no notifica nada al panel.
17. En el jugador, la rama que leería `roster_*` para aprender el puuid local es inalcanzable; el puuid sólo llega por `player_id` y por el marcador local (este último, además, no se persiste). Por eso un jugador nuevo sale "No app" hasta su primera partida.
18. El `player_id` persistido nunca caduca ni se valida: si otra persona usa la misma PC, se anuncia con el puuid del anterior.
19. Tras un `error` de GEP, todo queda deshabilitado hasta un nuevo `game-detected` (que puede no llegar sin reiniciar el juego). Sin aviso en la interfaz.

### 11.3 Rango y API de Riot

20. El contexto de Riot (tokens) se resuelve una vez por sesión y se cachea **también el fallo**: si el cliente de Riot no estaba abierto la primera vez, la vía local no se reintenta nunca; y los tokens de acceso caducan (~1 h) sin renovarse. Recomendación: caducar el contexto y reintentar.
21. **Clave de HenrikDev embebida en el binario.** Rotarla; en v2 sólo por entorno.
22. El sondeo de sala pide dos tokens y relee dos ficheros cada segundo; conviene cachear el contexto unos minutos.

### 11.4 Ventanas, teclas y ajustes

23. Ventana del jugador creada con alto 460 y máximo 320.
24. El diálogo "Estás en directo" nunca aparece en la práctica: la bandeja está activa por defecto (y forzada en `observer`), así que cerrar oculta. No hay forma desde la interfaz de cambiar la bandeja ni el inicio con Windows (canales no expuestos).
25. El patrón de validación de teclas rechaza `F12`–`F19` y acepta `F20`, `F21`, `F30`… Un error en una tecla deja las siguientes sin registrar. Además los atajos se registran aunque no haya conexión (las pulsaciones se pierden en silencio) y el registro puede fallar si otra app tiene la tecla (hoy no se comprueba).
26. `showToast` no hace nada.
27. En el aviso de Overwolf nativo se mata siempre el **primer** proceso de la lista, no el del diálogo.
28. El aviso de actualización sólo tiene "Update": no se puede posponer; cerrar el diálogo cuenta como "Update" y cierra la app.
29. El enlace profundo sólo se procesa si llega por segunda instancia; si abre la app en frío, se ignora.
30. "Restart to Latest" relanza contra un origen de paquetes de terceros no controlado por Easy. Recomendación: eliminar.

### 11.5 Build y empaquetado

31. **El build `normal` no incluye la copia del overlay ni el icono como recursos**: el servidor local sirve 404 en todo y la bandeja cae a icono vacío. Su `productName` es "Easy HUD", distinto del de identidad, y la guarda no lo comprueba (riesgo de stub 0.0.0 en ese build). Sus accesos directos apuntan a `Spectra Client.exe`, que con ese `productName` no existe. El propietario de publicación sigue siendo `No1seh`.
32. La copia del overlay que se empaqueta se mantiene a mano (ver §9.3).
33. Si un build de perfil falla a mitad, el perfil fijado (observer/player) no se restaura a `normal` y el siguiente `npm start` arranca como jugador u observador fijo. Hay rastro de ello (un perfil compilado de jugador suelto en la raíz del proyecto actual). Recomendación: inyectar el perfil por variable de build en vez de reescribir un fichero fuente.
34. La verificación de referencias del montaje sólo mira importaciones estáticas `from`, `url()` y `src`/`href`: no cubre `import()` dinámico ni importaciones sin `from`.

---

## 12. Criterios de aceptación mínimos para v2

1. Con VALORANT abierto y el build de observador, el log muestra una versión de GEP distinta de `0.0.0` y llegan `scoreboard`, `roster`, `round_info` y `score` al servidor v2.
2. El panel funciona sin tocar `overlay/`: login, dashboard (CRUD en las tres colecciones), atajos, ventana operador, fin de mapa (serie y persistencia), sala local, crear sala y llamar jugadores.
3. OBS con `http://localhost:5310/` muestra el overlay en vivo; el token no aparece en ninguna URL ni en la página.
4. Tras cortar la red 30 s durante una ronda, el observador vuelve a enviar datos sin intervención (ver §11.1.1).
5. El exe de jugador portátil arranca oculto en bandeja, late presencia, responde a "Call players" y envía vida, habilidades, `round_report` y marcadores.
6. Los datos existentes (`storage/*.json`, `localStorage` del panel, `%APPDATA%\spectra-client-player`) se conservan al actualizar desde 0.3.3.
7. La guarda de identidad falla el build si se toca cualquiera de los campos de §9.5.
