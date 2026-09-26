; Accesos directos extra del instalador normal (especificación §9.4).
;
; El instalador estándar ya crea "Spectra Client.lnk" (el exe se llama así
; porque el productName es el de la identidad de Overwolf). Aquí se añade el
; del jugador, que arranca el mismo exe con --auxiliary.
;
; Cambio: se quitó la página "Client Selection" del cliente anterior; los
; dos accesos se crean siempre.

!macro customInstall
  Delete "$SMPROGRAMS\[Player] ${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\[Player] ${PRODUCT_NAME}.lnk"
  CreateShortCut "$SMPROGRAMS\[Player] ${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--auxiliary"
  CreateShortCut "$DESKTOP\[Player] ${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--auxiliary"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\[Player] ${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\[Player] ${PRODUCT_NAME}.lnk"
!macroend
