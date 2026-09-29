# Easy HUD — cliente de escritorio (v2)

Programa de escritorio de Easy HUD para Windows, sobre **ow-electron** (la
distribución de Electron de Overwolf, con el Game Events Provider — GEP — de
VALORANT). **Implementación original de Easy HUD.**

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

## Identidad de Overwolf

`identidad.json` (y `name`/`author` de `package.json`) fijan la identidad
con la que Overwolf entrega el GEP. No se tocan: si cambian, GEP carga un stub
`0.0.0` y no llega ningún evento. `scripts/comprueba-identidad.mjs` falla el
build si no coinciden.

## Carpeta de datos

`localStorage` del panel (sesión, atajos) y `storage/*.json`:

- Observador: `%APPDATA%EasyHUD` (o `EASY_DIR_DATOS` si está definida).
- Jugador: `%APPDATA%EasyHUD-Jugador`.

## Perfiles y builds

El perfil se escribe en `app/perfil.json` **después** de compilar (dentro del
paquete); el código fuente no se reescribe. Sin ese fichero (desarrollo) el
perfil es `normal`. El build `normal` ahora incluye el overlay y el icono
como recursos.

`build/icon.ico` es provisional (lo genera `scripts/genera-icono.mjs`).

## Versión

`0.3.4`. El servidor v2 sólo acepta clientes `>= 0.3.3` y `< 0.3.25`
(`servidor-v2/src/version.ts`); una prueba de integración lo comprueba.

## Licencia

Propietario — © Easy HUD. Todos los derechos reservados. Ver `LICENSE`.
