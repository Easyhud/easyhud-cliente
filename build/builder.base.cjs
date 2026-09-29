/**
 * Lo común a los tres builds.
 *
 * La identidad de Overwolf (productName) sale de identidad.json, en un solo
 * sitio; `appId` NO se pone nunca (ver scripts/comprueba-identidad.mjs).
 *
 * Las rutas son relativas a la raíz del proyecto (donde está package.json).
 */

const identidad = require('../identidad.json');

module.exports = {
  productName: identidad.productName,
  /* Nombre visible del exe y de los accesos directos: propio, no el de la identidad. */
  executableName: 'EasyHUD',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['app/**/*', 'package.json', 'LICENSE'],
  electronLanguages: ['en-US'],
  compression: 'maximum',
  asar: true,
  win: { icon: 'build/icon.ico' },
  /* El overlay completo (lo genera scripts/monta-overlay.mjs) y el icono de la bandeja. */
  extraResources: [
    { from: 'overlay-empaquetado', to: 'overlay' },
    { from: 'build/icon.ico', to: 'icon.ico' },
  ],
};
