/**
 * Build `normal`: instalador web para el día a día del operador.
 *
 * Cambios respecto al cliente anterior: ahora SÍ incluye el overlay y el
 * icono (antes el servidor local servía 404 y la bandeja no tenía icono), el
 * productName es el de la identidad (antes "Easy HUD", fuera de la guarda) y
 * se publica en Easyhud/easyhud-client (antes No1seh).
 */

const base = require('./builder.base.cjs');

module.exports = {
  ...base,
  win: { ...base.win, target: ['nsis-web'] },
  nsisWeb: {
    artifactName: 'EasyHUD-Client-Setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: true,
    runAfterFinish: false,
    differentialPackage: true,
    include: 'build/instalador.nsh',
  },
  publish: [{ provider: 'github', owner: 'Easyhud', repo: 'easyhud-client', releaseType: 'draft' }],
};
