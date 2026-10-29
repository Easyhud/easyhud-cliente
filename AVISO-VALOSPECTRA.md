# Aviso: código adaptado de ValoSpectra

Esta rama (`copia-funcional`) incluye código **adaptado** del proyecto ValoSpectra
(https://github.com/ValoSpectra/Spectra-Client), publicado bajo la licencia **GNU General Public License v3.0 (GPL-3.0)**.
El texto de esa licencia está en `licencias-terceros/ValoSpectra-Spectra-Client-LICENSE`.

**Qué implica:** Si se reparte un programa compilado que incluya este código (el instalador del observador o el exe del jugador), hay que ofrecer también su código fuente bajo GPL-3.0.

Cada trozo adaptado lleva sobre él un comentario `Adaptado de ValoSpectra/Spectra-Client (...)` con el fichero de origen.
Los ficheros que contienen código adaptado en esta rama son:

- `src/principal/gep/adaptador.ts`
- `src/principal/gep/transforma.ts`
- `src/principal/modo-observador.ts`
- `src/principal/sistema/estado-eventos.ts`

La línea `testing` / `master` de este repositorio NO incluye este código (se escribió en sala limpia); esta rama no se
debe mezclar con ellas sin resolver antes las licencias. Uso actual: propio, en torneos propios, sin venta.