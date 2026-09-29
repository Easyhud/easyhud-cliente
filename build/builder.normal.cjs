/**
 * Build `normal`: instalador web para el día a día del operador.
 *
 * Incluye el overlay y el icono, el productName es el de la identidad
 * (`identidad.json`, fuera de la guarda) y se publica en
 * Easyhud/easyhud-cliente.
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
    shortcutName: 'Easy HUD',
    uninstallDisplayName: 'Easy HUD',
  },
  publish: [{ provider: 'github', owner: 'Easyhud', repo: 'easyhud-cliente', releaseType: 'draft' }],
};
