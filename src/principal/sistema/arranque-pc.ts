/**
 * Los datos REALES de las comprobaciones de arranque: lee el PC con las piezas que ya existen
 * (procesos, entorno, cliente de Riot, autoprueba de red) y se las da a `ComprobadorArranque`.
 * Sin lógica propia: la decisión está en `arranque.ts`, que es lo que se prueba.
 */

import { consejo, ejecutaAutoprueba } from '../diagnostico/autoprueba.ts';
import { sondeaConVersion, urlSonda } from '../diagnostico/sonda.ts';
import type { EstadoGep } from '../gep/adaptador.ts';
import { estadoClienteRiot } from '../riot/puuid-local.ts';
import type { DepsArranque } from './arranque.ts';
import { buscaConflictos } from './conflictos.ts';
import { leeEntornoDelPc } from './entorno.ts';
import { buscaOverwolf } from './overwolf-nativo.ts';
import { todosLosProcesos, valorantAbierto } from './procesos.ts';

export interface OpcionesDepsPc {
  rol: 'observador' | 'jugador';
  version: string;
  /** La URL de ingesta ya normalizada, o `null` (jugador sin dirección). */
  ingesta: string | null;
  gep: () => EstadoGep | null;
  eventosOverwolf: () => number | null;
  privilegiosRequeridos: () => boolean;
}

export function depsDelPc(o: OpcionesDepsPc): DepsArranque {
  return {
    rol: o.rol,
    version: o.version,
    riot: () => estadoClienteRiot(),
    valorantAbierto,
    entorno: async () => {
      const e = await leeEntornoDelPc(process.execPath);
      return { esAdmin: e.esAdmin, valorantElevado: e.valorantElevado, desdeTemporal: e.desdeTemporal };
    },
    conflictos: async () => ({
      conflictos: buscaConflictos(await todosLosProcesos(), process.pid),
      overwolfEscritorio: (await buscaOverwolf()).length,
    }),
    servidor: async () => {
      if (o.ingesta === null) return null;
      const url = urlSonda(o.ingesta);
      const r = url === null ? { ok: false, motivo: 'invalid server address', version: '' } : await sondeaConVersion(url);
      if (r.ok) return { ok: true, causa: '', arreglo: '', version: r.version };
      // No contesta: la autoprueba dice en qué paso se corta y qué hacer.
      const prueba = await ejecutaAutoprueba({ url: o.ingesta, tiempoMs: 4000 }).catch(() => null);
      return {
        ok: false,
        causa: prueba?.causa?.texto ?? r.motivo,
        arreglo: prueba?.causa ? consejo(prueba.causa.arreglo) : '',
        version: '',
      };
    },
    gep: () => {
      const g = o.gep();
      return {
        estado: g === null ? 'sin-api' : g.caido ? 'caido' : g.listo ? 'listo' : 'esperando',
        version: g?.version ?? '',
        detectado: g?.detectado === true,
      };
    },
    eventosOverwolf: o.eventosOverwolf,
    privilegiosRequeridos: o.privilegiosRequeridos,
  };
}
