/**
 * Otros programas que compiten por el mismo GEP de Overwolf.
 *
 * Dos programas con la identidad de Easy HUD (o un ValoSpectra / un Overwolf de escritorio) abiertos a la
 * vez se REPARTEN los datos del juego: a cada uno le llegan unas claves y no otras. El síntoma es el que
 * se vio en directo: el programa «funciona», está conectado y ve eventos, pero no recibe ni vida ni
 * habilidades ni marcador. Se buscan y se cuentan al servidor para que se vea en el panel y no se adivine.
 *
 * Qué cuenta como competidor: un proceso PRINCIPAL (sin `--type=`: esos son los hijos de Electron) de
 * Easy HUD, ValoSpectra, ow-electron o el Overwolf de escritorio, que no sea este programa, ni su
 * lanzador (el portable se desempaqueta y lanza otro proceso), ni uno de sus hijos.
 */

import type { Proceso } from './procesos.ts';

const COMPITE = /ow-electron|easy ?hud|valospectra|spectra-client|spectra client|overwolf\.exe|overwolfbrowser/i;
const MAX = 6;

/**
 * Los procesos que son este programa: él, su lanzador y los descendientes de ambos. El portable se
 * desempaqueta y lanza otro proceso, así que su padre (otro `EasyHUD…exe`) es «yo» también. Un antepasado
 * que NO es de Easy HUD (el explorador, un servicio) no se cuenta: arrastraría a medio sistema consigo.
 */
function propios(lista: Proceso[], yoPid: number): Set<number> {
  const porPid = new Map(lista.map((p) => [p.pid, p]));
  const mios = new Set<number>([yoPid]);
  for (let pid = yoPid, i = 0; i < 4; i++) {
    const padre = porPid.get(pid)?.padre ?? 0;
    const proceso = porPid.get(padre);
    if (proceso === undefined || mios.has(padre) || !COMPITE.test(proceso.ruta)) break;
    mios.add(padre);
    pid = padre;
  }
  let crece = true;
  while (crece) {
    crece = false;
    for (const p of lista) {
      if (!mios.has(p.pid) && mios.has(p.padre)) {
        mios.add(p.pid);
        crece = true;
      }
    }
  }
  return mios;
}

/** `Easy HUD (pid 1234)` para cada competidor, sin repetidos y con tope. Puro: se prueba. */
export function buscaConflictos(lista: Proceso[], yoPid: number): string[] {
  const mios = propios(lista, yoPid);
  const salida: string[] = [];
  for (const p of lista) {
    if (mios.has(p.pid) || /(^|\s)--type=/.test(p.orden)) continue;
    if (!COMPITE.test(p.ruta)) continue;
    const nombre = p.ruta.split(/[\\/]/).pop() || p.ruta;
    salida.push(`${nombre} (pid ${p.pid})`);
    if (salida.length >= MAX) break;
  }
  return salida;
}
