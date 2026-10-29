/**
 * demoEndText.js — the words of the demo-mode end card (ui/DemoEndCard.js) in every language the menu picker offers, in the
 * pattern of stillPlayingText.js: English is the base, a language block may leave a string out and `demoEndTextFor` shows
 * the English one.
 *
 * `caught` holds `{n}` (pieces caught) and `countdown` holds `{n}` (seconds until the new game). Thai, Japanese, Hindi and
 * Tamil drop letter spacing and CSS capitals (DECISIONS §44 row 5): `NO_SPACING_LANGS`, shared with the "Still playing?" card.
 *
 * REVIEW STATUS: English is the coordinator's wording (owner 2026-10-29); the six translations are model-made and have not
 * been checked by a native speaker.
 *
 * Pure data and lookups: no DOM, no settings read (the card passes the code in).
 * @module ui/demoEndText
 */

import { NO_SPACING_LANGS } from './stillPlayingText.js';

export { NO_SPACING_LANGS };

export const DEMO_END_KEYS = Object.freeze(['title', 'caught', 'next', 'playAgain', 'countdown']);

const EN = {
  title: 'Demo complete',
  caught: 'You caught {n} pieces of space junk.',
  next: 'Next, in the full game: catching two pieces at once with two daughters, whole dead satellites and swarms of small pieces.',
  playAgain: 'Play again',
  countdown: 'New game in {n}',
};

export const DEMO_END_TEXT = Object.freeze({
  en: Object.freeze(EN),
  th: Object.freeze({
    title: 'จบเดโม',
    caught: 'คุณจับขยะอวกาศได้ {n} ชิ้น',
    next: 'ในเกมเต็ม: จับสองชิ้นพร้อมกันด้วยยานลูกสองลำ ดาวเทียมที่ดับแล้วทั้งดวง และฝูงเศษชิ้นเล็กจำนวนมาก',
    playAgain: 'เล่นอีกครั้ง',
    countdown: 'เกมใหม่ใน {n}',
  }),
  ja: Object.freeze({
    title: 'デモ終了',
    caught: '宇宙ゴミを{n}個回収しました。',
    next: '製品版では、子機2機で2つの破片を同時に回収、役目を終えた衛星を丸ごと何基も、そして小さな破片の群れが待っています。',
    playAgain: 'もう一度遊ぶ',
    countdown: '{n}秒で新しいゲーム',
  }),
  es: Object.freeze({
    title: 'Demo completada',
    caught: 'Atrapaste {n} piezas de basura espacial.',
    next: 'Después, en el juego completo: atrapar dos piezas a la vez con dos hijas, satélites muertos enteros y enjambres de piezas pequeñas.',
    playAgain: 'Jugar de nuevo',
    countdown: 'Juego nuevo en {n}',
  }),
  pt: Object.freeze({
    title: 'Demo concluída',
    caught: 'Você capturou {n} peças de lixo espacial.',
    next: 'A seguir, no jogo completo: capturar duas peças ao mesmo tempo com duas filhas, satélites mortos inteiros e enxames de peças pequenas.',
    playAgain: 'Jogar de novo',
    countdown: 'Novo jogo em {n}',
  }),
  hi: Object.freeze({
    title: 'डेमो पूरा हुआ',
    caught: 'आपने अंतरिक्ष के कचरे के {n} टुकड़े पकड़े।',
    next: 'पूरे गेम में आगे: दो बेटी-यानों के साथ एक साथ दो टुकड़े पकड़ना, पूरे के पूरे मृत उपग्रह और छोटे टुकड़ों के झुंड।',
    playAgain: 'फिर से खेलें',
    countdown: '{n} में नया गेम',
  }),
  ta: Object.freeze({
    title: 'டெமோ முடிந்தது',
    caught: 'நீங்கள் {n} விண்வெளிக் குப்பைத் துண்டுகளைப் பிடித்தீர்கள்.',
    next: 'முழு விளையாட்டில் அடுத்து: இரண்டு மகள் கலங்களுடன் இரண்டு துண்டுகளை ஒரே நேரத்தில் பிடித்தல், முழுமையான செயலிழந்த செயற்கைக்கோள்கள் மற்றும் சிறு துண்டுகளின் கூட்டங்கள்.',
    playAgain: 'மீண்டும் விளையாடு',
    countdown: '{n} வினாடியில் புதிய விளையாட்டு',
  }),
});

/**
 * The strings for a language code; a missing or empty string (or an unknown code) shows English.
 * @param {string} [code]
 * @returns {{ title: string, caught: string, next: string, playAgain: string, countdown: string }}
 */
export function demoEndTextFor(code) {
  const block = (typeof code === 'string' && Object.prototype.hasOwnProperty.call(DEMO_END_TEXT, code)) ? DEMO_END_TEXT[code] : null;
  const out = {};
  for (const k of DEMO_END_KEYS) {
    const v = block && block[k];
    out[k] = (typeof v === 'string' && v.trim()) ? v : EN[k];
  }
  return out;
}

/** "You caught 5 pieces of space junk." in `code`. */
export function caughtLine(code, n) {
  return demoEndTextFor(code).caught.replace('{n}', String(Math.max(0, Math.floor(Number(n) || 0))));
}

/** "New game in 20" in `code`. */
export function countdownLine(code, n) {
  return demoEndTextFor(code).countdown.replace('{n}', String(Math.max(0, Math.ceil(n))));
}

export default DEMO_END_TEXT;
