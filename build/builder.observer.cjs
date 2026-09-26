/** Build `observer`: instalador fijo del observador, con la IP de ingesta quemada. */

const base = require('./builder.base.cjs');

module.exports = {
  ...base,
  win: { ...base.win, target: ['nsis'] },
  nsis: {
    artifactName: 'EasyHUD-Observer-Setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: true,
  },
  publish: null,
};
