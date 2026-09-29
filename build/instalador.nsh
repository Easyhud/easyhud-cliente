; Accesos directos extra del instalador normal.
;
; El instalador estándar crea el acceso directo del observador. Aquí se añade
; el del jugador, que arranca el mismo exe con --auxiliary.
;
; Los dos accesos directos (observador y jugador) se crean siempre.

!macro customInstall
  Delete "$SMPROGRAMS\Easy HUD Jugador.lnk"
  Delete "$DESKTOP\Easy HUD Jugador.lnk"
  CreateShortCut "$SMPROGRAMS\Easy HUD Jugador.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--auxiliary"
  CreateShortCut "$DESKTOP\Easy HUD Jugador.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--auxiliary"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Easy HUD Jugador.lnk"
  Delete "$DESKTOP\Easy HUD Jugador.lnk"
!macroend
