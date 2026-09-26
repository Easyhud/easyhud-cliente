/**
 * Build `player`: exe portátil del jugador, sin admin. Sólo carga
 * `renderer/jugador.html`, así que no lleva el panel ni el overlay.
 */

const base = require('./builder.base.cjs');

module.exports = {
  ...base,
  directories: { ...base.directories, output: 'dist-player' },
  files: [
    ...base.files,
    '!app/renderer/panel/**',
    '!app/renderer/comun/**',
    '!app/renderer/fonts/**',
    '!app/renderer/fonts.css',
  ],
  extraResources: [{ from: 'build/icon.ico', to: 'icon.ico' }],
  win: { ...base.win, target: ['portable'], requestedExecutionLevel: 'asInvoker' /* sin admin */ },
  portable: { artifactName: 'EasyHUD-Player.${ext}', unpackDirName: 'EasyHUD-Player' },
  publish: null,
};
