/**
 * Genera `build/icon.ico` (provisional): una "E" blanca sobre el negro del
 * panel, en 16, 32, 48 y 256 px. Sin dependencias: PNG a mano con zlib y
 * un contenedor ICO con los PNG dentro.
 *
 * Se ejecuta una vez y el resultado se versiona; cuando haya icono de diseño,
 * se sustituye el fichero y este script sobra.
 *
 * Uso: node scripts/genera-icono.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function trozo(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

/** ¿El píxel (x, y) de un lienzo unidad [0,1) es parte de la "E"? */
function esLetra(x, y) {
  const dentro = (x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  return (
    dentro(0.3, 0.22, 0.42, 0.78) || // palo
    dentro(0.3, 0.22, 0.72, 0.33) || // brazo de arriba
    dentro(0.3, 0.445, 0.64, 0.555) || // brazo del medio
    dentro(0.3, 0.67, 0.72, 0.78) // brazo de abajo
  );
}

function png(lado) {
  const filas = [];
  for (let y = 0; y < lado; y++) {
    const fila = Buffer.alloc(1 + lado * 4);
    for (let x = 0; x < lado; x++) {
      // Supermuestreo 4×4 para suavizar los bordes en tamaños pequeños.
      let cubre = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) cubre += esLetra((x + (sx + 0.5) / 4) / lado, (y + (sy + 0.5) / 4) / lado) ? 1 : 0;
      const t = cubre / 16;
      const mezcla = (fondo, letra) => Math.round(fondo + (letra - fondo) * t);
      fila.set([mezcla(0x08, 0xf2), mezcla(0x08, 0xf2), mezcla(0x0a, 0xf4), 255], 1 + x * 4);
    }
    filas.push(fila);
  }
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(lado, 0);
  cabecera.writeUInt32BE(lado, 4);
  cabecera.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', cabecera),
    trozo('IDAT', deflateSync(Buffer.concat(filas), { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

const lados = [16, 32, 48, 256];
const imagenes = lados.map(png);
const cabecera = Buffer.alloc(6);
cabecera.writeUInt16LE(0, 0);
cabecera.writeUInt16LE(1, 2); // icono
cabecera.writeUInt16LE(lados.length, 4);
let desplazamiento = 6 + 16 * lados.length;
const entradas = lados.map((lado, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(lado >= 256 ? 0 : lado, 0);
  e.writeUInt8(lado >= 256 ? 0 : lado, 1);
  e.writeUInt16LE(1, 4); // planos
  e.writeUInt16LE(32, 6); // bits por píxel
  e.writeUInt32LE(imagenes[i].length, 8);
  e.writeUInt32LE(desplazamiento, 12);
  desplazamiento += imagenes[i].length;
  return e;
});
const destino = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico');
writeFileSync(destino, Buffer.concat([cabecera, ...entradas, ...imagenes]));
console.log(`icono escrito en ${destino}`);
