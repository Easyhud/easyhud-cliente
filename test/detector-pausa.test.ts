/**
 * Detector de pausa por pantalla: el juego se ve en gris en cada timeout / pausa técnica.
 * Las cifras de «color» salen de capturas reales: en gris ~0,3 % de los píxeles tiene color; en juego normal ~38 %.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetectorPausa, esGris, mide, type Fotograma } from '../src/principal/sistema/detector-pausa.ts';

/** Un fotograma BGRA relleno: `colorido` es la fracción de píxeles rojos; el resto, gris de `luz`. */
function fotograma(colorido: number, luz: number, n = 1000): Fotograma {
  const datos = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const rojo = i < n * colorido;
    datos.set(rojo ? [20, 20, 220, 255] : [luz, luz, luz, 255], i * 4); // B G R A
  }
  return { datos, ancho: n, alto: 1 };
}

test('mide: separa el juego en gris, el juego con color y la pantalla negra', () => {
  assert.ok(esGris(mide(fotograma(0.003, 118))), 'gris real de una captura');
  assert.ok(!esGris(mide(fotograma(0.38, 118))), 'color normal');
  assert.ok(!esGris(mide(fotograma(0, 2))), 'negro (carga / alt-tab) no es pausa');
  assert.ok(!esGris(mide(fotograma(0.08, 90))), 'un escritorio oscuro con algo de color no es pausa');
});

test('detector: hacen falta varias muestras seguidas para cambiar, y avisa una sola vez por cambio', () => {
  const avisos: boolean[] = [];
  const d = new DetectorPausa({ captura: async () => null, alCambiar: (a) => avisos.push(a), paraActivar: 3, paraDesactivar: 2 });
  const gris = mide(fotograma(0.003, 118));
  const color = mide(fotograma(0.38, 118));
  d.procesa(gris);
  d.procesa(gris);
  assert.deepEqual(avisos, [], 'con 2 muestras todavía no');
  d.procesa(gris);
  assert.deepEqual(avisos, [true], 'a la tercera, pausa');
  d.procesa(gris);
  d.procesa(gris);
  assert.deepEqual(avisos, [true], 'no repite');
  d.procesa(color);
  assert.deepEqual(avisos, [true], 'una muestra con color no basta (parpadeo)');
  d.procesa(gris);
  d.procesa(color);
  d.procesa(color);
  assert.deepEqual(avisos, [true, false], 'dos con color seguidas: termina');
});

test('detector: hacen falta el gris Y el timer quieto; si el timer se mueve, no es pausa, y si vuelve a moverse, termina', () => {
  const avisos: boolean[] = [];
  const d = new DetectorPausa({ captura: async () => null, alCambiar: (a) => avisos.push(a), paraActivar: 2, paraDesactivar: 2 });
  const gris = mide(fotograma(0.003, 118));
  d.procesa({ ...gris, quietoMs: 300 });
  d.procesa({ ...gris, quietoMs: 400 });
  d.procesa({ ...gris, quietoMs: 500 });
  assert.deepEqual(avisos, [], 'gris pero el timer corre → no es pausa');
  d.procesa({ ...gris, quietoMs: 1600 });
  assert.deepEqual(avisos, [], 'una muestra no basta');
  d.procesa({ ...gris, quietoMs: 1700 });
  assert.deepEqual(avisos, [true], 'gris + timer quieto → pausa');
  const color = mide(fotograma(0.38, 118));
  d.procesa({ ...color, quietoMs: 1800 });
  d.procesa({ ...color, quietoMs: 1900 });
  assert.deepEqual(avisos, [true, false], 'vuelve el color → termina');
  // Color normal con el timer quieto (un instante en el menú) tampoco es pausa.
  d.procesa({ ...color, quietoMs: 5000 });
  d.procesa({ ...color, quietoMs: 5100 });
  assert.deepEqual(avisos, [true, false]);
});

test('detector: una pantalla negra en medio no cuenta ni a favor ni en contra', () => {
  const avisos: boolean[] = [];
  const d = new DetectorPausa({ captura: async () => null, alCambiar: (a) => avisos.push(a), paraActivar: 3 });
  const gris = mide(fotograma(0.003, 118));
  const negro = mide(fotograma(0, 1));
  d.procesa(gris);
  d.procesa(negro);
  d.procesa(gris);
  d.procesa(gris);
  assert.deepEqual(avisos, [true]);
  d.procesa(negro);
  d.procesa(negro);
  assert.deepEqual(avisos, [true], 'el negro no quita la pausa');
});

test('detector: muestra() captura, mide y no se pisa a sí mismo; un fallo de captura no lo rompe', async () => {
  const avisos: boolean[] = [];
  let capturas = 0;
  const d = new DetectorPausa({
    captura: async () => {
      capturas++;
      if (capturas === 1) throw new Error('sin permiso');
      return fotograma(0.003, 118);
    },
    alCambiar: (a) => avisos.push(a),
    paraActivar: 2,
  });
  await d.muestra();
  await d.muestra();
  await d.muestra();
  assert.deepEqual(avisos, [true]);
  d.para();
  assert.deepEqual(avisos, [true, false], 'al parar, si había pausa, se retira');
});

test('detector: una vez en pausa NO parpadea: el timer moviéndose o un poco de color no la quitan, sólo el color claro', () => {
  const avisos: boolean[] = [];
  const d = new DetectorPausa({ captura: async () => null, alCambiar: (a) => avisos.push(a), paraActivar: 2, paraDesactivar: 3 });
  const gris = mide(fotograma(0.003, 118));
  d.procesa({ ...gris, quietoMs: 2000 });
  d.procesa({ ...gris, quietoMs: 2100 });
  assert.deepEqual(avisos, [true]);
  for (let i = 0; i < 10; i++) d.procesa({ ...gris, quietoMs: 100 }); // el juego dibuja algo en la zona del timer
  assert.deepEqual(avisos, [true], 'el timer moviéndose no la quita');
  const algo = mide(fotograma(0.05, 118)); // un poco de color (entre el umbral de entrada y el de salida)
  for (let i = 0; i < 10; i++) d.procesa({ ...algo, quietoMs: 100 });
  assert.deepEqual(avisos, [true], 'un poco de color tampoco');
  const color = mide(fotograma(0.38, 118));
  d.procesa({ ...color, quietoMs: 0 });
  d.procesa({ ...color, quietoMs: 0 });
  assert.deepEqual(avisos, [true], 'dos muestras con color no bastan');
  d.procesa({ ...color, quietoMs: 0 });
  assert.deepEqual(avisos, [true, false], 'tres, sí');
});
