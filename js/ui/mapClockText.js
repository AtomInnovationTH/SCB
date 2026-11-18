/**
 * mapClockText.js — the words of the map clock slider (floors 4-5) in every language the menu picker offers, in the pattern
 * of js/ui/stillPlayingText.js and helpText.js (DECISIONS §44): English is the base, a language block may leave a string out and
 * `mapClockTextFor` shows the English one. The "10x / 100x / 1000x" buttons are numbers and need no translation.
 *
 * Keys: `caption` (the label over the buttons), `pause`, `real` (the short button word for real speed), `realTitle` (the longer
 * tooltip), `trip` (the label while a transfer trip sets the speed itself), `aria` (the group's accessible name).
 *
 * REVIEW STATUS: the six translations are model-made and have not been checked by a native speaker (DECISIONS §44 row 2).
 * Thai, Japanese, Hindi and Tamil drop letter spacing and CSS capitals (`NO_SPACING_LANGS`, §44 row 5).
 *
 * Pure data and one lookup: no DOM, no settings read.
 * @module ui/mapClockText
 */

export const MAP_CLOCK_KEYS = Object.freeze(['caption', 'pause', 'real', 'realTitle', 'trip', 'aria']);

/** Languages whose scripts join: no wide letter spacing, no CSS capitals. */
export const NO_SPACING_LANGS = Object.freeze(['th', 'ja', 'hi', 'ta']);

const EN = {
  caption: 'Time speed', pause: 'Pause', real: 'Real', realTitle: 'Real time: one game second per real second',
  trip: 'Trip speed', aria: 'How fast time runs on the map',
};

export const MAP_CLOCK_TEXT = Object.freeze({
  en: Object.freeze(EN),
  th: Object.freeze({
    caption: 'ความเร็วเวลา', pause: 'หยุด', real: 'จริง', realTitle: 'เวลาจริง: หนึ่งวินาทีในเกมต่อหนึ่งวินาทีจริง',
    trip: 'ความเร็วการเดินทาง', aria: 'เวลาบนแผนที่เดินเร็วแค่ไหน',
  }),
  ja: Object.freeze({
    caption: '時間の速さ', pause: '停止', real: '実時間', realTitle: '実時間: ゲームの1秒が現実の1秒',
    trip: '移動中の速さ', aria: '地図上の時間の速さ',
  }),
  es: Object.freeze({
    caption: 'Velocidad del tiempo', pause: 'Pausa', real: 'Real', realTitle: 'Tiempo real: un segundo de juego por segundo real',
    trip: 'Velocidad del viaje', aria: 'Qué tan rápido corre el tiempo en el mapa',
  }),
  pt: Object.freeze({
    caption: 'Velocidade do tempo', pause: 'Pausa', real: 'Real', realTitle: 'Tempo real: um segundo de jogo por segundo real',
    trip: 'Velocidade da viagem', aria: 'Quão rápido o tempo corre no mapa',
  }),
  hi: Object.freeze({
    caption: 'समय की गति', pause: 'रुकें', real: 'असली', realTitle: 'असली समय: खेल का एक सेकंड, असली एक सेकंड',
    trip: 'यात्रा की गति', aria: 'नक्शे पर समय कितनी तेज़ चलता है',
  }),
  ta: Object.freeze({
    caption: 'நேரத்தின் வேகம்', pause: 'நிறுத்து', real: 'உண்மை', realTitle: 'உண்மை நேரம்: விளையாட்டின் ஒரு வினாடி = நிஜ ஒரு வினாடி',
    trip: 'பயண வேகம்', aria: 'வரைபடத்தில் நேரம் எவ்வளவு வேகமாக ஓடுகிறது',
  }),
});

/**
 * The strings for a language code; a missing or empty string (or an unknown code) shows English.
 * @param {string} [code]
 * @returns {{caption:string, pause:string, real:string, realTitle:string, trip:string, aria:string}}
 */
export function mapClockTextFor(code) {
  const block = (typeof code === 'string' && Object.prototype.hasOwnProperty.call(MAP_CLOCK_TEXT, code)) ? MAP_CLOCK_TEXT[code] : null;
  const out = {};
  for (const k of MAP_CLOCK_KEYS) {
    const v = block && block[k];
    out[k] = (typeof v === 'string' && v.trim()) ? v : EN[k];
  }
  return out;
}

export default MAP_CLOCK_TEXT;
