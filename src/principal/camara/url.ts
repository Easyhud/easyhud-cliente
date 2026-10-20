/**
 * La cámara del jugador: qué se publica y con qué dirección. Todo puro (sin
 * Electron) para poder probarlo.
 *
 * El ID del stream es `Nombre_H_TAG` con todo lo no alfanumérico a «_»: es la
 * misma regla que aplica la web de vídeo al publicar y la que usa el overlay
 * para pedir al jugador que está observando, así que el emparejamiento no
 * necesita ninguna tabla.
 */

/** Lo que manda el servidor en `cam_config`. */
export interface ConfigCamara {
  enable: boolean;
  room: string;
  base: string;
  params: string;
  clave: string;
}

const textoDe = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Valida la carga de `cam_config`; `null` si no es utilizable. */
export function leeConfigCamara(carga: unknown): ConfigCamara | null {
  if (typeof carga !== 'object' || carga === null) return null;
  const c = carga as Record<string, unknown>;
  const base = textoDe(c.base).replace(/\/+$/, '');
  // Sólo https (o localhost, para pruebas) y sin ruta: es lo que se carga en una ventana.
  if (!/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(base)) return null;
  return {
    enable: c.enable === true,
    room: textoDe(c.room),
    base,
    params: textoDe(c.params).replace(/^[?&]+/, ''),
    clave: textoDe(c.clave),
  };
}

/** `Nombre#TAG` (el que da GEP) → ID de stream; `null` si no hay TAG. */
export function idDeCamara(nombreCompleto: string): string | null {
  const i = nombreCompleto.lastIndexOf('#');
  if (i <= 0 || i === nombreCompleto.length - 1) return null;
  const nick = nombreCompleto.slice(0, i);
  const tag = nombreCompleto.slice(i + 1);
  return `${nick}_H_${tag}`.replace(/\W+/g, '_').slice(0, 64);
}

/** ¿Hay que publicar ahora? */
export function debePublicar(c: ConfigCamara | null, nombreCompleto: string): boolean {
  return c !== null && c.enable && c.room !== '' && idDeCamara(nombreCompleto) !== null;
}

/** La dirección que abre la ventana oculta del jugador para publicar. */
export function urlPublicacion(c: ConfigCamara, nombreCompleto: string, dispositivo = ''): string {
  const id = idDeCamara(nombreCompleto);
  if (id === null) throw new Error('el nombre no tiene TAG');
  const p = [
    `push=${encodeURIComponent(id)}`,
    `room=${encodeURIComponent(c.room)}`,
    'webcam',
    'autostart',
    'noaudio',
    'cleanoutput',
    'nopreview',
    'hidehome',
    'vb=3500',
    // Sin `fps` ni `quality`: fuerzan restricciones exactas y una webcam que no las cumple no arranca.
  ];
  if (dispositivo !== '') p.push(`videodevice=${encodeURIComponent(dispositivo)}`);
  if (c.clave !== '') p.push(`password=${encodeURIComponent(c.clave)}`);
  if (c.params !== '') p.push(c.params);
  return `${c.base}/?${p.join('&')}`;
}
