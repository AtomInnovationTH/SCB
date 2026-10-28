/**
 * stillPlayingText.js — the words of the "Still playing?" card in every language the menu picker offers (fresh-start D3,
 * owner 2026-10-28), in the pattern of js/ui/helpText.js (DECISIONS §44): English is the base, every other language
 * block may leave a string out and `stillPlayingTextFor` shows the English one instead.
 *
 * `line` holds `{n}`, replaced by the seconds left. Thai, Japanese, Hindi and Tamil drop letter spacing and CSS capitals
 * (§44 row 5: they break joined scripts): `NO_SPACING_LANGS`.
 *
 * REVIEW STATUS: the six translations are model-made and have not been checked by a native speaker.
 *
 * Pure data and one lookup: no DOM, no settings read here (the card passes the code in).
 * @module ui/stillPlayingText
 */

export const STILL_PLAYING_KEYS = Object.freeze(['title', 'line', 'keep', 'newPlayer']);

/** Languages whose scripts join: no wide letter spacing, no CSS capitals. */
export const NO_SPACING_LANGS = Object.freeze(['th', 'ja', 'hi', 'ta']);

const EN = { title: 'Still playing?', line: 'New player in {n}', keep: 'Keep playing', newPlayer: 'New player' };

export const STILL_PLAYING_TEXT = Object.freeze({
  en: Object.freeze(EN),
  th: Object.freeze({ title: 'ยังเล่นอยู่ไหม?', line: 'ผู้เล่นใหม่ใน {n}', keep: 'เล่นต่อ', newPlayer: 'ผู้เล่นใหม่' }),
  ja: Object.freeze({ title: 'まだプレイ中ですか?', line: '{n}秒で新しいプレイヤー', keep: '続ける', newPlayer: '新しいプレイヤー' }),
  es: Object.freeze({ title: '¿Sigues jugando?', line: 'Nuevo jugador en {n}', keep: 'Seguir jugando', newPlayer: 'Nuevo jugador' }),
  pt: Object.freeze({ title: 'Ainda está jogando?', line: 'Novo jogador em {n}', keep: 'Continuar jogando', newPlayer: 'Novo jogador' }),
  hi: Object.freeze({ title: 'क्या आप अभी भी खेल रहे हैं?', line: '{n} में नया खिलाड़ी', keep: 'खेलते रहें', newPlayer: 'नया खिलाड़ी' }),
  ta: Object.freeze({ title: 'இன்னும் விளையாடுகிறீர்களா?', line: '{n} வினாடியில் புதிய வீரர்', keep: 'தொடர்ந்து விளையாடு', newPlayer: 'புதிய வீரர்' }),
});

/**
 * The four strings for a language code; a missing or empty string (or an unknown code) shows English.
 * @param {string} [code]
 * @returns {{ title: string, line: string, keep: string, newPlayer: string }}
 */
export function stillPlayingTextFor(code) {
  const block = (typeof code === 'string' && Object.prototype.hasOwnProperty.call(STILL_PLAYING_TEXT, code)) ? STILL_PLAYING_TEXT[code] : null;
  const out = {};
  for (const k of STILL_PLAYING_KEYS) {
    const v = block && block[k];
    out[k] = (typeof v === 'string' && v.trim()) ? v : EN[k];
  }
  return out;
}

/** The countdown line with the seconds filled in. */
export function countdownLine(code, n) {
  return stillPlayingTextFor(code).line.replace('{n}', String(Math.max(0, Math.ceil(n))));
}

export default STILL_PLAYING_TEXT;
