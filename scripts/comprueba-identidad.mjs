/**
 * Guarda de identidad de Overwolf (especificación §9.5).
 *
 * Overwolf sólo sirve el GEP real a identidades que reconoce. Si cambia
 * CUALQUIERA de estos campos, GEP carga un stub 0.0.0: la app parece normal
 * pero no llega ni un evento, sin ningún error. Por eso esto falla el build.
 *
 * Se comprueba, contra lo APROBADO (abajo):
 *   · identidad.json                          (la fuente única)
 *   · package.json → name, author.name, author.url, overwolf.packages
 *   · las TRES configuraciones del builder → productName, y que no haya appId
 *
 * Cuando Overwolf apruebe la identidad propia de Easy HUD se cambia APROBADA
 * (y identidad.json y package.json). La comprobación no se borra. Ver README.
 *
 * Uso: node scripts/comprueba-identidad.mjs   (salida 1 si algo no casa)
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** TEMPORAL hasta que Overwolf apruebe Easy HUD: identidad prestada de ValoSpectra. */
const APROBADA = {
  name: 'spectra-client',
  authorName: 'Purple Shark UG (haftungsbeschränkt)',
  authorUrl: 'https://www.valospectra.com',
  productName: 'Spectra Client',
  packages: ['gep'],
};

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Lista de discrepancias (vacía = todo bien). aiz = carpeta del proyecto (las pruebas usan una copia). */
export function compruebaIdentidad(raiz = RAIZ) {
  const lee = (f) => JSON.parse(readFileSync(join(raiz, f), 'utf8'));
  const fallos = [];
  const igual = (que, visto, esperado) => {
    const a = JSON.stringify(visto);
    const b = JSON.stringify(esperado);
    if (a !== b) fallos.push(`${que}: es ${a}, debe ser ${b}`);
  };

  const identidad = lee('identidad.json');
  igual('identidad.json → name', identidad.name, APROBADA.name);
  igual('identidad.json → author.name', identidad.author?.name, APROBADA.authorName);
  igual('identidad.json → author.url', identidad.author?.url, APROBADA.authorUrl);
  igual('identidad.json → productName', identidad.productName, APROBADA.productName);
  igual('identidad.json → overwolfPackages', identidad.overwolfPackages, APROBADA.packages);

  const paquete = lee('package.json');
  igual('package.json → name', paquete.name, APROBADA.name);
  igual('package.json → author.name', paquete.author?.name, APROBADA.authorName);
  igual('package.json → author.url', paquete.author?.url, APROBADA.authorUrl);
  igual('package.json → overwolf.packages', paquete.overwolf?.packages, APROBADA.packages);
  if ('productName' in paquete) fallos.push('package.json → productName: no debe existir (cambiaría el nombre de la app y su carpeta de datos)');
  if ('build' in paquete) fallos.push('package.json → build: la configuración del builder va en build/builder.*.cjs');

  // Sin caché: las configuraciones leen identidad.json y se quiere lo que hay en disco ahora.
  for (const clave of Object.keys(require.cache)) {
    if (clave.startsWith(join(raiz, 'build')) || clave === join(raiz, 'identidad.json')) delete require.cache[clave];
  }
  for (const perfil of ['normal', 'observer', 'player']) {
    const ruta = join(raiz, 'build', `builder.${perfil}.cjs`);
    const config = require(ruta);
    igual(`build/builder.${perfil}.cjs → productName`, config.productName, APROBADA.productName);
    if ('appId' in config) fallos.push(`build/builder.${perfil}.cjs → appId: debe estar AUSENTE (vale ${JSON.stringify(config.appId)})`);
  }
  return fallos;
}

const esPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esPrincipal) {
  const fallos = compruebaIdentidad();
  if (fallos.length > 0) {
    console.error('✗ La identidad de Overwolf NO coincide con la aprobada:');
    for (const f of fallos) console.error(`  · ${f}`);
    console.error(
      '\nEsto no es estético: con otra identidad GEP carga un stub 0.0.0 y NO entrega eventos, sin avisar.\n' +
        'Si Overwolf ya aprobó la identidad de Easy HUD, actualiza APROBADA en scripts/comprueba-identidad.mjs (ver README).',
    );
    process.exit(1);
  }
  console.log(`✓ identidad de GEP intacta (${APROBADA.name} / ${APROBADA.productName})`);
}
