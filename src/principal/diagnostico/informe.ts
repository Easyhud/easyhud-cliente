/**
 * El informe completo de un PC («caja negra») y sus conclusiones automáticas.
 *
 * Junta en un solo documento TODO lo que hace falta para saber por qué a un PC le llegan unos datos del
 * juego y a otro no: el estado del programa, lo que Overwolf entregó (y lo que no), lo que Overwolf DICE
 * tener (`getInfo`, `getFeatures`), el entorno de la máquina, la red, los conflictos y el log. Y saca de
 * ahí las conclusiones que se pueden afirmar con las pruebas a la vista, cada una con su evidencia, para
 * que no haya que adivinar.
 *
 * Puro: recibe los datos ya recogidos y devuelve el documento. Quien lo llama (`modo-jugador.ts`) hace la
 * recogida, que es lo que toca Overwolf, PowerShell y el disco.
 */

import type { ResultadoAutoprueba } from './autoprueba.ts';
import type { Alerta, CargaDiagnostico, EstadoRed } from './diagnostico.ts';
import type { InstantaneaGep } from './grabadora-gep.ts';
import type { Entorno } from '../sistema/entorno.ts';

export interface EntradaInforme {
  creado: number;
  version: string;
  perfil: string;
  jugador: string;
  diag: CargaDiagnostico;
  red: EstadoRed;
  alertas: Alerta[];
  autoprueba: ResultadoAutoprueba | null;
  gep: {
    version: string;
    /** `getFeatures` de VALORANT; `null` si no se pudo preguntar. */
    features: string[] | null;
    featuresError: string;
    /** Claves que GEP dice tener ahora (`getInfo`); `null` si no se pudo preguntar. */
    infoClaves: string[] | null;
    infoError: string;
  };
  grabacion: InstantaneaGep;
  entorno: Entorno | null;
  conflictos: string[];
  /** Últimas líneas del log del programa. */
  log: string[];
}

export type Certeza = 'confirmada' | 'probable' | 'info';

export interface Conclusion {
  id: string;
  certeza: Certeza;
  /** Lo que se concluye, en una frase. */
  texto: string;
  /** Las pruebas del informe en las que se apoya. */
  evidencia: string;
}

/** Claves que un jugador DEBE recibir cuando está en partida, por feature de GEP. */
const DE_JUGADOR = ['health', 'abilities'];

const tieneClave = (g: InstantaneaGep, k: string): boolean => Object.hasOwn(g.porClave, k);
const viaAvisos = (g: InstantaneaGep, k: string): boolean => (g.porClave[k]?.via ?? []).some((v) => v === 'info' || v === 'evento');
const viaSondeo = (g: InstantaneaGep, k: string): boolean => (g.porClave[k]?.via ?? []).includes('sondeo');

/** ¿Hay datos de PARTIDA en la grabación? (si no, no se puede juzgar la vida ni las habilidades) */
function huboPartida(g: InstantaneaGep): boolean {
  return tieneClave(g, 'kills') || tieneClave(g, 'round_phase') || tieneClave(g, 'scoreboard_N') || tieneClave(g, 'match_start');
}

export function conclusiones(e: EntradaInforme): Conclusion[] {
  const c: Conclusion[] = [];
  const g = e.grabacion;
  const sucesos = g.sucesos.map((s) => s.key);

  // — Programa y red —
  if (e.diag.gep === 'caido' || e.diag.gep === 'sin-api') {
    c.push({ id: 'gep-caido', certeza: 'confirmada', texto: 'El paquete de Overwolf (GEP) está caído: no hay datos del juego posibles.', evidencia: `estado de GEP: ${e.diag.gep}` });
  }
  if (e.autoprueba !== null && !e.autoprueba.ok && e.autoprueba.causa !== null) {
    c.push({ id: 'red', certeza: 'confirmada', texto: `No se llega al servidor: ${e.autoprueba.causa.texto}`, evidencia: `autoprueba de red: ${e.autoprueba.resumen}` });
  }
  if (e.diag.riot.startsWith('not signed')) {
    c.push({ id: 'riot', certeza: 'confirmada', texto: 'El programa no ve el cliente de Riot (cerrado o sin sesión): no puede saber quién es.', evidencia: e.diag.riot });
  }

  // — Quién más usa Overwolf y cómo se lanzó —
  if (e.conflictos.length > 0) {
    c.push({ id: 'conflicto', certeza: 'confirmada', texto: `Hay otros programas usando Overwolf a la vez (${e.conflictos.join(', ')}): se reparten los datos.`, evidencia: 'lista de procesos' });
  }
  if (e.entorno !== null && e.entorno.overwolfAbierto > 0) {
    c.push({ id: 'overwolf-escritorio', certeza: 'probable', texto: 'El Overwolf de escritorio está abierto y puede pisar a este programa.', evidencia: `${e.entorno.overwolfAbierto} proceso(s) de Overwolf` });
  }

  // — Privilegios: el motivo más típico de «ve el juego pero no los datos» —
  if (sucesos.includes('elevated-privileges-required')) {
    c.push({ id: 'elevado', certeza: 'confirmada', texto: 'VALORANT corre como administrador y Easy HUD no: Overwolf no puede leerlo. Hay que ejecutar los dos con los mismos permisos.', evidencia: 'GEP emitió «elevated-privileges-required»' });
  } else if (e.entorno !== null && e.entorno.valorantElevado === true && e.entorno.esAdmin === false) {
    c.push({ id: 'elevado', certeza: 'probable', texto: 'VALORANT parece correr como administrador y Easy HUD no: Overwolf no podría leerlo.', evidencia: 'no se pudo leer el proceso de VALORANT desde este programa' });
  }

  // — GEP no ve el juego, o lo ve y no entrega —
  if (e.diag.juegoAbierto && !e.diag.juegoDetectado) {
    c.push({ id: 'no-detecta', certeza: 'confirmada', texto: 'VALORANT está abierto pero Overwolf no lo detecta. Suele arreglarse abriendo Easy HUD ANTES que VALORANT, y con los mismos permisos.', evidencia: 'proceso de VALORANT presente, GEP sin «game-detected»' });
  }
  const errores = g.sucesos.filter((s) => s.key === 'error');
  if (errores.length > 0) {
    c.push({ id: 'gep-error', certeza: 'confirmada', texto: `GEP informó de un error: ${errores.at(-1)?.valor ?? ''}`, evidencia: 'suceso «error» de GEP' });
  }
  if (e.diag.gep === 'listo' && e.diag.juegoDetectado && g.total === 0) {
    c.push({ id: 'sin-nada', certeza: 'confirmada', texto: 'GEP está listo y ve el juego, pero no ha entregado NI UN dato.', evidencia: 'la grabadora está vacía' });
  }

  // — El caso que se vio en directo: ve eventos pero falta vida y habilidades —
  if (huboPartida(g)) {
    const faltan = DE_JUGADOR.filter((k) => !viaAvisos(g, k));
    if (faltan.length > 0 && e.diag.espectador) {
      c.push({ id: 'espectador', certeza: 'confirmada', texto: 'El programa se cree espectador y por eso no manda vida ni habilidades.', evidencia: 'flag de espectador activo' });
    } else if (faltan.length > 0) {
      const enInfo = e.gep.infoClaves !== null && faltan.every((k) => e.gep.infoClaves?.includes(k));
      const sondeo = faltan.filter((k) => viaSondeo(g, k));
      if (sondeo.length === faltan.length) {
        c.push({ id: 'avisos-perdidos', certeza: 'confirmada', texto: `Overwolf TIENE ${faltan.join(' y ')} pero no los avisa: llegan sólo por el sondeo de getInfo (el programa ya los recoge así).`, evidencia: `llegaron por el sondeo: ${sondeo.join(', ')}` });
      } else if (enInfo) {
        c.push({ id: 'avisos-perdidos', certeza: 'confirmada', texto: `Overwolf TIENE ${faltan.join(' y ')} en su estado pero no los avisa.`, evidencia: 'presentes en getInfo, ausentes de los avisos' });
      } else if (e.gep.features !== null && !e.gep.features.includes('me')) {
        c.push({ id: 'sin-feature-me', certeza: 'confirmada', texto: 'Esta versión de GEP no ofrece la feature «me» (vida y habilidades): no hay forma de recibirlas aquí.', evidencia: `getFeatures: ${e.gep.features.join(', ')}` });
      } else if (e.gep.infoClaves !== null) {
        c.push({ id: 'overwolf-no-entrega', certeza: 'confirmada', texto: `En este PC, Overwolf NO genera ${faltan.join(' ni ')} (ni por avisos ni en su estado), aunque sí entrega otras claves (${Object.keys(g.porClave).slice(0, 6).join(', ')}…). No es del programa ni de la red: es de la instalación de Overwolf o del juego en este PC.`, evidencia: `ausentes de los avisos y de getInfo; features pedidas: ${(e.gep.features ?? ['?']).join(', ')}` });
      } else {
        c.push({ id: 'faltan-datos', certeza: 'probable', texto: `No llegan ${faltan.join(' ni ')} de Overwolf (no se pudo consultar su estado para confirmar el motivo).`, evidencia: `grabadora: ${g.total} datos, sin ${faltan.join(', ')}` });
      }
    }
  } else if (e.diag.datos === 'conectada') {
    c.push({ id: 'sin-partida', certeza: 'info', texto: 'Todavía no ha habido datos de PARTIDA en esta sesión: no se puede juzgar si recibe la vida y las habilidades. Repetir el informe durante una partida.', evidencia: 'sin kills / round_phase / scoreboard en la grabadora' });
  }

  // — Información de contexto —
  if (e.entorno !== null && e.entorno.antivirus.length > 0) {
    c.push({ id: 'antivirus', certeza: 'info', texto: `Antivirus detectado: ${e.entorno.antivirus.join(', ')}. Si nada más lo explica, probar a excluir Easy HUD y Overwolf.`, evidencia: 'SecurityCenter2' });
  }
  if (e.entorno?.desdeTemporal === true) {
    c.push({ id: 'portable', certeza: 'info', texto: 'El programa corre desde una carpeta temporal (versión portable). Es normal.', evidencia: e.entorno.ejecutable });
  }

  if (c.every((x) => x.certeza === 'info')) {
    if (!e.diag.juegoAbierto && !e.diag.juegoDetectado) {
      // Sin juego no se puede juzgar lo importante (vida, habilidades): no se dice «todo bien».
      c.unshift({ id: 'sin-juego', certeza: 'info', texto: 'VALORANT no está abierto: el informe NO puede juzgar los datos del juego. Repetirlo durante una partida.', evidencia: 'proceso de VALORANT ausente' });
    } else {
      c.unshift({ id: 'sin-problemas', certeza: 'info', texto: 'No se detecta ningún problema en este PC con lo observado hasta ahora.', evidencia: 'ninguna regla se activó' });
    }
  }
  return c;
}

/** El documento completo. */
export function armaInforme(e: EntradaInforme) {
  return {
    formato: 1,
    creado: new Date(e.creado).toISOString(),
    programa: { version: e.version, perfil: e.perfil },
    jugador: e.jugador,
    conclusiones: conclusiones(e),
    estado: e.diag,
    red: e.red,
    alertas: e.alertas,
    autoprueba: e.autoprueba,
    gep: { ...e.gep, claveSinAvisos: DE_JUGADOR.filter((k) => !viaAvisos(e.grabacion, k)) },
    grabacion: e.grabacion,
    entorno: e.entorno,
    conflictos: e.conflictos,
    log: e.log,
  };
}
