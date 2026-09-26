# Easy HUD — cliente de escritorio (v2)

Programa de escritorio de Easy HUD para Windows, sobre **ow-electron** (la
distribución de Electron de Overwolf, con el Game Events Provider — GEP — de
VALORANT). **Implementación original de Easy HUD**, escrita en sala limpia a
partir de `docs/especificacion.md`, sin código del cliente anterior ni de
ValoSpectra.

Dos caras según el perfil:

- **Observador** (PC del realizador): lee GEP y lo manda al servidor de
  partidas (`servidor-v2`, ingesta 5100); aloja el panel del operador
  (`overlay/panel/`) como ventana principal; sirve el overlay de OBS en
  `http://localhost:5310/` y releva su conexión al servidor poniendo el token
  (que nunca llega al navegador); guarda la base local (equipos, matches,
  torneos). Beta: sala del cliente de Riot, crear sala, "Call players".
- **Jugador** ("auxiliar"): sin interfaz, en la bandeja. Manda vida,
  habilidades, informe de ronda y marcador de compañeros, y late su presencia
  para que el operador pueda llamarle.

## Órdenes

```bash
npm install          # también instala dependencias nativas del builder
npm start            # desarrollo: limpiar → guarda → tsc → montar overlay → ow-electron --development
npm run start:player # lo mismo con --auxiliary (modo jugador)
npm test             # node --test (unitarias + integración con ../servidor-v2 real)
npm run typecheck    # tsc --noEmit
npm run build        # instalador normal (nsis-web)          → dist/EasyHUD-Client-Setup.exe
npm run build:observer  # instalador fijo del observador      → dist/EasyHUD-Observer-Setup.exe
npm run build:player    # exe portátil del jugador            → dist-player/EasyHUD-Player.exe
npm run test:identidad  # sólo la guarda de identidad de Overwolf
npm run monta        # sólo montar renderer + overlay empaquetado
```

Requisitos: Node ≥ 22.6, Windows. Las pruebas de integración importan
`../servidor-v2/src/servidor.ts`, así que esa carpeta hermana debe existir con
sus `node_modules` instalados.

No hay ESLint: el proyecto se apoya en `tsc` estricto (`npm run typecheck`).

## Arquitectura

```
GEP (Overwolf) ─▶ gep/adaptador ─▶ gep/observador | gep/jugador   (traductores PUROS: dato → acciones)
                                         │
                                         ▼
                  modo-observador | modo-jugador   (ejecutan las acciones)
                   │            │             │
                   ▼            ▼             ▼
         enlace/conexion   panel (IPC)   local/servidor-local (5310: estáticos + relevo → 5200)
           (5100, relogon      ▲
            en cada connect)   │
                          preload/puente.cts  (window.electronAPI)
```

| Fichero | Qué hace |
|---|---|
| `src/principal/principal.ts` | Secuencia de arranque: carpeta de datos, instancia única, log, ventana, IPC, actualizaciones, GEP, protocolo. |
| `src/principal/perfil.ts` | Perfiles `normal`/`observer`/`player` y rol efectivo. |
| `src/principal/urls.ts` | Normalización de la URL de ingesta y derivación de la de salida. |
| `src/principal/gep/adaptador.ts` | Única pieza que habla con la API de Overwolf (features, `game-detected`, info/eventos). |
| `src/principal/gep/transforma.ts` | Tablas A–E: de GEP a los tipos del servidor. |
| `src/principal/gep/observador.ts` | Traductor del observador (marcador, roster, killfeed, fases, fin de mapa…). |
| `src/principal/gep/jugador.ts` | Traductor del jugador y lo que manda el bucle de 300 ms. |
| `src/principal/gep/acciones.ts` | Tipos de las acciones y del evento `serie-mapa-fin`. |
| `src/principal/enlace/conexion.ts` | Socket de datos contra la ingesta; logon en cada `connect`, estados, "Call players". |
| `src/principal/enlace/mensajes.ts` | Cargas de `obs_logon`/`aux_logon` y traducción de rechazos (tabla F). |
| `src/principal/enlace/presencia.ts` | Presencia del jugador (`cliente_presente`, `te_llaman`). |
| `src/principal/local/servidor-local.ts` | Servidor 127.0.0.1:5310: overlay estático + relevo socket.io con el token. |
| `src/principal/local/estaticos.ts` | Resolución de rutas (403 fuera de la raíz) y tipos MIME. |
| `src/principal/modo-observador.ts` | Orquesta el observador: acciones, sesión, teclas, sala, ventana operador. |
| `src/principal/modo-jugador.ts` | Orquesta el jugador: acciones, logon por matchId o por grupo, bucle. |
| `src/principal/ipc.ts` · `canales.ts` | Canales IPC del puente y manejadores `db:*`. |
| `src/preload/puente.cts` | `window.electronAPI` para el panel (sin canal genérico). |
| `src/principal/almacen.ts` · `coleccion.ts` | Almacén clave→`storage/<clave>.json` y CRUD de la base local. |
| `src/principal/secreto.ts` | Secreto de reconexión, matchId y puuid persistidos. |
| `src/principal/ventanas.ts` · `bandeja.ts` | Ventanas (principal, jugador, operador) y bandeja. |
| `src/principal/atajos.ts` | Validación y plan de las teclas globales. |
| `src/principal/riot/*` | API local de Riot (zona gris): contexto, rango, sala, crear sala. |
| `src/principal/sistema/*` | Actualizaciones, Overwolf nativo, estado de eventos, carpeta de datos. |
| `src/principal/registro.ts` | Log a fichero con rotación; el token nunca entero. |
| `scripts/monta-overlay.mjs` | Monta `app/renderer` y `overlay-empaquetado/` desde `../overlay`, verificando referencias. |
| `scripts/comprueba-identidad.mjs` | Guarda de identidad de Overwolf. |
| `scripts/construye.mjs` · `desarrollo.mjs` · `comun.mjs` | Builds por perfil y arranque de desarrollo. |
| `build/builder.*.cjs` | Configuraciones de ow-electron-builder (base + normal/observer/player). |

Dependencias de ejecución: `socket.io-client` (enlace, presencia, relevo) y
`socket.io` (servidor del relevo local). Nada más: el log, el almacén JSON y
las peticiones a Riot son propios.

## Identidad de Overwolf: temporal hasta que Overwolf apruebe Easy HUD

Overwolf sólo entrega el GEP real a identidades de app que reconoce. La de
Easy HUD aún no está aprobada, así que los builds usan **la identidad
prestada** del cliente del que partió el proyecto:

| Campo | Valor |
|---|---|
| `package.json` → `name` | `spectra-client` |
| `package.json` → `author.name` | `Purple Shark UG (haftungsbeschränkt)` |
| `package.json` → `author.url` | `https://www.valospectra.com` |
| builder (los tres perfiles) → `productName` | `Spectra Client` |
| builder → `appId` | **ausente** |
| `package.json` → `overwolf.packages` | `["gep"]` |

Si cambia **cualquiera**, GEP carga un stub `0.0.0`: la app parece normal pero
**no llega ni un evento**, sin error. El log lo marca (`GEP 0.0.0: …`).

Dónde vive:

- `identidad.json` — la fuente única; los tres `build/builder.*.cjs` sacan de
  ahí el `productName`.
- `package.json` — `name` y `author` tienen que estar ahí literalmente (npm y
  Overwolf los leen de ese fichero).
- `scripts/comprueba-identidad.mjs` — la guarda: compara lo anterior con la
  identidad `APROBADA` y **falla el build** si algo no casa. Corre en
  `npm start`, en todos los builds y en `npm test`.

**Cómo cambiar a la identidad propia** cuando Overwolf la apruebe:

1. Actualiza `APROBADA` en `scripts/comprueba-identidad.mjs` con los valores
   aprobados (no borres la comprobación).
2. Pon los mismos en `identidad.json` y en `package.json` (`name`, `author`).
3. `npm test` y `npm start`: el log debe mostrar una versión de GEP distinta
   de `0.0.0` con VALORANT abierto.
4. **Ojo con los datos**: el `name` decide la carpeta de datos por defecto de
   Electron. Antes de publicar, fija `EASY_DIR_DATOS` o añade la carpeta vieja
   (`spectra-client`) a `HEREDADAS` en `src/principal/sistema/datos.ts` (ya
   está) para que los operadores no pierdan su sesión ni su base local. El
   jugador usa siempre `%APPDATA%\spectra-client-player`, que no cambia.

## Carpeta de datos

Ahí están el `localStorage` del panel (sesión, atajos) y `storage/*.json`
(misma forma y nombres que el cliente anterior). Reglas
(`src/principal/sistema/datos.ts`):

1. Jugador: siempre `%APPDATA%\spectra-client-player`.
2. `EASY_DIR_DATOS`, si está definida.
3. La carpeta por defecto de Electron (`%APPDATA%\spectra-client`, por el
   `name` del paquete) si ya tiene datos.
4. Si no, la primera heredada con datos: `spectra-client`, `Spectra Client`,
   `Easy HUD`.
5. Instalación nueva: la de Electron por defecto.

**A confirmar en una máquina con el 0.3.3 instalado.** En la máquina de
desarrollo existen `%APPDATA%\spectra-client` (observador, en uso) y
`%APPDATA%\spectra-client-player`, lo que cuadra con la regla 3; también hay un
`%APPDATA%\Easy HUD Client` de origen desconocido que no se usa.

## Perfiles y builds

El perfil se escribe en `app/perfil.json` **después** de compilar (dentro del
paquete); el código fuente no se reescribe. Sin ese fichero (desarrollo) el
perfil es `normal`. El build `normal` ahora incluye el overlay y el icono
como recursos.

`build/icon.ico` es provisional (lo genera `scripts/genera-icono.mjs`).

## Versión

`0.3.4`. El servidor v2 sólo acepta clientes `>= 0.3.3` y `< 0.3.25`
(`servidor-v2/src/version.ts`); una prueba de integración lo comprueba.

## Documentación

- `docs/especificacion.md` — la especificación funcional (fuente de este código).
- `docs/cambios-vs-comportamiento-anterior.md` — qué se corrigió, qué se quitó
  y qué decisiones se tomaron donde la especificación dejaba margen.

## Licencia

Propietario — © Easy HUD. Todos los derechos reservados. Ver `LICENSE`.
