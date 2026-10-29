/**
 * Build `player`: exe portátil del jugador. SÓLO carga `renderer/jugador.html`, así que no lleva el panel ni el overlay.
 *
 * PIDE ADMINISTRADOR al abrirse (Windows enseña su aviso de permisos). Motivo: si VALORANT corre como administrador
 * (muy común: «ejecutar como administrador» en el acceso directo de Riot o de VALORANT), Overwolf no puede leer el juego
 * desde un programa sin esos privilegios y el resultado es «NO EVENTS»: GEP listo, juego detectado y ni un dato. Con el
 * programa elevado funciona tanto si VALORANT es administrador como si no. Hay que pedirlo en DOS sitios: el lanzador
 * portable (`portable.requestExecutionLevel`) y el programa desempaquetado (`win.requestedExecutionLevel`); si sólo se
 * pide en el segundo, el lanzador no elevado no puede abrirlo.
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
  win: { ...base.win, target: ['portable'], requestedExecutionLevel: 'requireAdministrator' },
  portable: { artifactName: 'EasyHUD-Player.${ext}', unpackDirName: 'EasyHUD-Player', requestExecutionLevel: 'admin' },
  publish: null,
};
