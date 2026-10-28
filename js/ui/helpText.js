/**
 * helpText.js — the words of the "?" help page in every language the menu picker offers
 * (DECISIONS §44, owner 2026-10-27).
 *
 * WHERE THE WORDS LIVE
 *   • English rows and group titles stay in `HOTKEY_GROUPS` (js/ui/HotkeyOverlay.js), the shape many tests read.
 *     Each row there carries a stable `id` in its opts object; `HELP_TEXT.en` below holds only the strings that are
 *     not in that table (title, close hint, close label, "not yet", the overview).
 *   • Every other language block holds EVERYTHING visible: those five strings, a title for each group id, a
 *     description for each row id, and the words of the gesture chips (`chips`, keyed by row id: "Wheel · pinch" and
 *     the like). Key caps (W, Tab, Shift, arrows, ?, ESC, numbers) are never translated. Three chips name an on-screen
 *     button whose label is still English in the game (CHANGE TOOL, Hold RADIATORS, Main menu), so they stay English
 *     in every language. The same goes for "DAUGHTERS" inside two descriptions.
 *   • The B row has two ids, `upgrades` (the stop after a mission) and `upgrades_map` (the satellite, when the range
 *     map is on), chosen by the same condition `wordsFor()` uses for English.
 *
 *   • The FAQ ("Questions", DECISIONS row "Help", owner 2026-10-28): the group title is `groups.faq` and the link label plus every question and
 *     answer is `faq` ({ link, items: { <id>: { q, a } } }); both sit in the FAQ section further down and are merged into
 *     each block by `withFaq`. English questions and answers live in HOTKEY_GROUPS (the `faq` group's `items`).
 *
 * REVIEW STATUS: the six translations (th, ja, es, pt, hi, ta) are model-made and have not been checked by a native
 * speaker. A reviewer edits one language block; `helpTextFor` falls back to English for any missing or empty key, and
 * test-HelpLanguages.js fails when a block lacks a key.
 *
 * Pure data and one lookup: no DOM, no settings read here (the overlay reads the language and passes the code in).
 *
 * @module ui/helpText
 */

/** Gesture chips (words, not keys) that each language block translates, keyed by row id. */
export const HELP_CHIP_IDS = Object.freeze(['zoom', 'touch', 'turn_pad', 'turn_view', 'inspect']);

/** The scalar strings every language block holds. */
export const HELP_SCALAR_KEYS = Object.freeze(['title', 'closeHint', 'closeLabel', 'notYet', 'overview']);

const EN = {
  title: 'KEYS & CONTROLS',
  closeHint: 'press ? or ESC to close',
  closeLabel: 'Close',
  notYet: 'not yet',
  // The overview: what you are doing and why, the reward, the next action (DECISIONS §44 row 4).
  overview: 'You are cleaning up dangerous space junk before it hits satellites. '
    + 'Press S to scan, N to net a piece (A flies you closer); each catch earns credits for upgrades and more nets.',
  groups: {},
  rows: {},
  chips: {},
};

const TH = {
  title: 'ปุ่มและการควบคุม',
  closeHint: 'กด ? หรือ ESC เพื่อปิด',
  closeLabel: 'ปิด',
  notYet: 'ยังไม่มี',
  overview: 'คุณกำลังเก็บกวาดขยะอวกาศอันตรายก่อนที่มันจะชนดาวเทียม กด S เพื่อสแกน กด N เพื่อยิงแหใส่ชิ้นที่เจอ (กด A เพื่อบินเข้าใกล้) ทุกชิ้นที่จับได้จะได้เครดิตไปอัปเกรดและซื้อแหเพิ่ม',
  groups: { start: 'เริ่มที่นี่', daughters: 'ยานลูก', ship: 'ยานและมุมมอง', stuck: 'ติดขัด?', advanced: 'ขั้นสูง' },
  chips: {
    zoom: ['ล้อเมาส์ · บีบนิ้ว'], touch: ['แตะ · กดค้าง'], turn_pad: ['แป้นหมุน'], turn_view: ['ลาก'], inspect: ['ชี้ · คลิก'],
  },
  rows: {
    zoom: 'ซูมเข้า / ออก',
    touch: 'สัมผัส: สแกน / สั่งงาน',
    turn: 'หมุนยาน',
    turn_pad: 'หมุนยาน (สัมผัส ล่างซ้าย)',
    scan: 'สแกน',
    net: 'ยิงแห',
    fly: 'บินไปที่เป้าหมาย (เปิด / ปิด)',
    select: 'เลือกยานลูก',
    launch_d: 'ปล่อยยานลูกที่เลือก',
    pair: 'ปล่อยคู่ที่ทำเครื่องหมาย',
    reel: 'ดึงยานลูกที่เลือกกลับ',
    next_tool: 'เครื่องมือถัดไป',
    use_tool: 'ใช้เครื่องมือ',
    move_catch: 'ย้ายของที่จับไปแผงระบายความร้อน',
    view_mother: 'เปลี่ยนมุมมองเป็นยานแม่',
    next_target: 'เป้าหมายถัดไป',
    main_action: 'การกระทำหลัก',
    back: 'ย้อนกลับ',
    pause: 'หยุดชั่วคราว',
    upgrades: 'อัปเกรด (ซื้อที่จุดเติมเสบียง)',
    upgrades_map: 'อัปเกรด (ซื้อที่ดาวเทียมเติมเสบียง)',
    info: 'ข้อมูล',
    journal: 'บันทึก',
    radiator_out: 'ก้านแผงระบายความร้อน ออก / เข้า',
    struts: 'ก้านยึด ออก / เข้า (ที่เลือก / ทั้งหมด)',
    wings: 'ปีกโซลาร์ ออก / เข้า',
    stuck_scan: 'ไม่มีอะไรให้จับ? สแกน',
    stuck_fly: 'แหไม่ยิง? บินเข้าใกล้',
    stuck_hot: 'ร้อนเกินไป? เปิดแผงระบายความร้อน',
    stuck_empty: 'สนามว่าง? ที่ LEO กด Space',
    turn_view: 'หมุนมุมมอง',
    drawer: 'สัมผัส: แตะท้ายลิ้นชักสองครั้ง',
    hold_rad: 'แผงระบายความร้อนไป 180°',
    wide_scan: 'สแกนกว้าง',
    next_part: 'ชิ้นส่วนเศษซากถัดไป',
    laser: 'กดค้าง: เลเซอร์ลดการหมุน',
    nose_catch: 'ปล่อยของที่จับหัวยาน',
    throttle: 'ลด / เพิ่มกำลังเครื่อง',
    power_line: 'เลือกสายไฟ',
    power_adj: 'ไฟน้อยลง / มากขึ้น',
    tether: 'สายโยงไฟฟ้า ออก / เข้า',
    launch_all: 'ปล่อยทั้งหมด ชิ้นละหนึ่ง',
    send_all: 'ส่งทั้งหมดไปชิ้นที่ดีที่สุด',
    launch_speed: 'ความเร็วปล่อย ลด / เพิ่ม',
    circle: 'วนรอบเป้าหมาย',
    range: 'ใกล้ขึ้น / ไกลขึ้น',
    change_tool: 'เครื่องมือถัดไป (แถว DAUGHTERS)',
    reel_all: 'ดึงยานลูกทั้งหมดกลับ',
    reel_fast: 'กดค้าง: ดึงเร็วขึ้น',
    cut: 'ตัดสายโยง',
    burn: 'เผาของที่จับ',
    inspect: 'ตรวจ / อัปเกรดชิ้นส่วน',
    panels: 'แผงน้อยลง / มากขึ้น',
    cities: 'เมือง / กลุ่มดาว',
    info_panes: 'ข้อมูลเป้าหมาย / แผงเป้าหมาย',
    radio: 'บันทึกวิทยุ',
    nav: 'ลูกบอลนำทาง',
    big_catch: 'ของใหญ่: เลือกว่าจะทำอย่างไร',
    furnace: 'เตาหลอม (ยังไม่สร้าง)',
    thruster_metal: 'โลหะสำหรับเครื่องขับ',
    net_sweep: 'กวาดด้วยแห',
    dev_auto: 'Dev: เล่นอัตโนมัติ',
  },
};

const JA = {
  title: 'キーと操作',
  closeHint: '? か ESC で閉じる',
  closeLabel: '閉じる',
  notYet: '未実装',
  overview: '危険な宇宙ゴミを、衛星にぶつかる前に片付けます。S でスキャン、N で見つけたものにネットを投げ (A で近づく)、捕まえるとクレジットが入り、アップグレードとネット補充に使えます。',
  groups: { start: 'はじめに', daughters: '子機', ship: '船と視点', stuck: '困ったら?', advanced: '上級' },
  chips: {
    zoom: ['ホイール · ピンチ'], touch: ['タップ · 長押し'], turn_pad: ['回転パッド'], turn_view: ['ドラッグ'], inspect: ['ポイント · クリック'],
  },
  rows: {
    zoom: 'ズーム イン / アウト',
    touch: 'タッチ: スキャン / 操作',
    turn: '船を回す',
    turn_pad: '船を回す (タッチ・左下)',
    scan: 'スキャン',
    net: 'ネット発射',
    fly: 'ターゲットへ飛ぶ (オン / オフ)',
    select: '子機を選ぶ',
    launch_d: '選んだ子機を発進',
    pair: '印を付けたペアを発進',
    reel: '選んだ子機を巻き取る',
    next_tool: '次のツール',
    use_tool: 'ツールを使う',
    move_catch: '獲物をラジエーターへ移す',
    view_mother: '母船の視点に切替',
    next_target: '次のターゲット',
    main_action: 'メインアクション',
    back: '戻る',
    pause: '一時停止',
    upgrades: 'アップグレード (補給所で購入)',
    upgrades_map: 'アップグレード (補給衛星で購入)',
    info: '情報',
    journal: '日誌',
    radiator_out: 'ラジエーター支柱 出す / 戻す',
    struts: '支柱 出す / 戻す (選択 / 全部)',
    wings: '太陽電池翼 出す / 戻す',
    stuck_scan: '獲物がない? スキャン',
    stuck_fly: 'ネットが出ない? 近づく',
    stuck_hot: '熱すぎる? ラジエーターを開く',
    stuck_empty: '宙域が空っぽ? LEO で Space',
    turn_view: '視点を回す',
    drawer: 'タッチ: 引き出し下部を2回タップ',
    hold_rad: 'ラジエーターを180°へ',
    wide_scan: '広域スキャン',
    next_part: '次のデブリ部位',
    laser: '長押し: レーザーで回転を減らす',
    nose_catch: '船首の獲物を放す',
    throttle: 'スロットル 下げる / 上げる',
    power_line: '電源ラインを選ぶ',
    power_adj: '出力 下げる / 上げる',
    tether: '電気テザー 出す / 戻す',
    launch_all: '全機発進 (1機1個)',
    send_all: '全機を最適な破片へ',
    launch_speed: '発進速度 下げる / 上げる',
    circle: 'ターゲットを周回',
    range: '近づく / 離れる',
    change_tool: '次のツール (DAUGHTERS 行)',
    reel_all: '全子機を巻き取る',
    reel_fast: '長押し: 速く巻く',
    cut: 'テザーを切る',
    burn: '獲物を燃やす',
    inspect: '部位を調べる / 強化',
    panels: 'パネル 減らす / 増やす',
    cities: '都市 / 星座',
    info_panes: 'ターゲット情報 / ターゲット欄',
    radio: '無線ログ',
    nav: 'ナビボール',
    big_catch: '大きな獲物: 処理を選ぶ',
    furnace: '炉 (未完成)',
    thruster_metal: 'スラスター用金属',
    net_sweep: 'ネット掃引',
    dev_auto: '開発: 自動プレイ',
  },
};

const ES = {
  title: 'TECLAS Y CONTROLES',
  closeHint: 'pulsa ? o ESC para cerrar',
  closeLabel: 'Cerrar',
  notYet: 'aún no',
  overview: 'Limpias basura espacial peligrosa antes de que choque con satélites. Pulsa S para escanear y N para lanzar una red a una pieza (A te acerca); cada captura da créditos para mejoras y más redes.',
  groups: { start: 'Empieza aquí', daughters: 'Hijas', ship: 'Nave y vistas', stuck: '¿Atascado?', advanced: 'Avanzado' },
  chips: {
    zoom: ['Rueda · pinza'], touch: ['Toque · mantener'], turn_pad: ['Pad de giro'], turn_view: ['Arrastrar'], inspect: ['Ratón · clic'],
  },
  rows: {
    zoom: 'Acercar / alejar',
    touch: 'Táctil: escanear / acciones',
    turn: 'Girar la nave',
    turn_pad: 'Girar nave (táctil, abajo izq.)',
    scan: 'Escanear',
    net: 'Lanzar red',
    fly: 'Volar al objetivo (sí / no)',
    select: 'Elegir una hija',
    launch_d: 'Lanzar la hija elegida',
    pair: 'Lanzar el par marcado',
    reel: 'Recoger la hija elegida',
    next_tool: 'Siguiente herramienta',
    use_tool: 'Usar herramienta',
    move_catch: 'Pasar captura al radiador',
    view_mother: 'Vista de la nave madre',
    next_target: 'Siguiente objetivo',
    main_action: 'Acción principal',
    back: 'Atrás',
    pause: 'Pausa',
    upgrades: 'Mejoras (comprar en la parada)',
    upgrades_map: 'Mejoras (comprar en el satélite)',
    info: 'Info',
    journal: 'Diario',
    radiator_out: 'Brazos radiador fuera / dentro',
    struts: 'Brazos fuera / dentro (uno / todos)',
    wings: 'Alas solares fuera / dentro',
    stuck_scan: '¿Nada que atrapar? Escanea',
    stuck_fly: '¿No sale la red? Acércate',
    stuck_hot: '¿Mucho calor? Abre el radiador',
    stuck_empty: '¿Campo vacío? En LEO, Space',
    turn_view: 'Girar la vista',
    drawer: 'Táctil: cajón abajo, 2 toques',
    hold_rad: 'Radiadores a 180°',
    wide_scan: 'Escaneo amplio',
    next_part: 'Siguiente parte del escombro',
    laser: 'Mantener: el láser frena el giro',
    nose_catch: 'Soltar captura de la proa',
    throttle: 'Acelerador menos / más',
    power_line: 'Elegir línea de energía',
    power_adj: 'Energía menos / más',
    tether: 'Cable eléctrico fuera / dentro',
    launch_all: 'Lanzar todas, una por pieza',
    send_all: 'Enviar todas a las mejores',
    launch_speed: 'Lanzar: más lento / rápido',
    circle: 'Girar alrededor del objetivo',
    range: 'Más cerca / más lejos',
    change_tool: 'Siguiente herramienta (DAUGHTERS)',
    reel_all: 'Recoger todas las hijas',
    reel_fast: 'Mantener: recoger más rápido',
    cut: 'Cortar el cable',
    burn: 'Quemar la captura',
    inspect: 'Inspeccionar / mejorar pieza',
    panels: 'Menos / más paneles',
    cities: 'Ciudades / constelaciones',
    info_panes: 'Info de objetivo / paneles',
    radio: 'Registro de radio',
    nav: 'Esfera de navegación',
    big_catch: 'Captura grande: elegir destino',
    furnace: 'Horno (sin construir)',
    thruster_metal: 'Metal para propulsor',
    net_sweep: 'Barrido de red',
    dev_auto: 'Dev: juego automático',
  },
};

const PT = {
  title: 'TECLAS E CONTROLES',
  closeHint: 'pressione ? ou ESC para fechar',
  closeLabel: 'Fechar',
  notYet: 'ainda não',
  overview: 'Você limpa lixo espacial perigoso antes que atinja satélites. Pressione S para escanear e N para lançar uma rede numa peça (A aproxima você); cada captura rende créditos para melhorias e mais redes.',
  groups: { start: 'Comece aqui', daughters: 'Filhas', ship: 'Nave e vistas', stuck: 'Travado?', advanced: 'Avançado' },
  chips: {
    zoom: ['Roda · pinça'], touch: ['Toque · segurar'], turn_pad: ['Pad de giro'], turn_view: ['Arrastar'], inspect: ['Mouse · clique'],
  },
  rows: {
    zoom: 'Aproximar / afastar',
    touch: 'Toque: escanear / ações',
    turn: 'Girar a nave',
    turn_pad: 'Girar nave (toque, canto esq.)',
    scan: 'Escanear',
    net: 'Lançar rede',
    fly: 'Voar até o alvo (liga / desliga)',
    select: 'Escolher uma filha',
    launch_d: 'Lançar a filha escolhida',
    pair: 'Lançar o par marcado',
    reel: 'Recolher a filha escolhida',
    next_tool: 'Próxima ferramenta',
    use_tool: 'Usar ferramenta',
    move_catch: 'Levar captura ao radiador',
    view_mother: 'Vista da nave-mãe',
    next_target: 'Próximo alvo',
    main_action: 'Ação principal',
    back: 'Voltar',
    pause: 'Pausa',
    upgrades: 'Melhorias (compre na parada)',
    upgrades_map: 'Melhorias (compre no satélite)',
    info: 'Info',
    journal: 'Diário',
    radiator_out: 'Hastes do radiador fora / dentro',
    struts: 'Hastes fora / dentro (uma / todas)',
    wings: 'Asas solares fora / dentro',
    stuck_scan: 'Nada para pegar? Escaneie',
    stuck_fly: 'Rede não sai? Chegue perto',
    stuck_hot: 'Muito quente? Abra o radiador',
    stuck_empty: 'Campo vazio? No LEO, Space',
    turn_view: 'Girar a vista',
    drawer: 'Toque: gaveta embaixo, 2 toques',
    hold_rad: 'Radiadores a 180°',
    wide_scan: 'Escaneamento amplo',
    next_part: 'Próxima parte do detrito',
    laser: 'Segurar: laser reduz o giro',
    nose_catch: 'Soltar captura do nariz',
    throttle: 'Aceleração menos / mais',
    power_line: 'Escolher linha de energia',
    power_adj: 'Energia menos / mais',
    tether: 'Cabo elétrico fora / dentro',
    launch_all: 'Lançar todas, uma por peça',
    send_all: 'Enviar todas às melhores peças',
    launch_speed: 'Lançar: mais lento / rápido',
    circle: 'Girar em volta do alvo',
    range: 'Mais perto / mais longe',
    change_tool: 'Próxima ferramenta (DAUGHTERS)',
    reel_all: 'Recolher todas as filhas',
    reel_fast: 'Segurar: recolher mais rápido',
    cut: 'Cortar o cabo',
    burn: 'Queimar a captura',
    inspect: 'Inspecionar / melhorar peça',
    panels: 'Menos / mais painéis',
    cities: 'Cidades / constelações',
    info_panes: 'Info do alvo / painéis',
    radio: 'Registro de rádio',
    nav: 'Esfera de navegação',
    big_catch: 'Captura grande: escolher destino',
    furnace: 'Forno (não construído)',
    thruster_metal: 'Metal do propulsor',
    net_sweep: 'Varredura de rede',
    dev_auto: 'Dev: jogo automático',
  },
};

const HI = {
  title: 'कुंजियाँ और नियंत्रण',
  closeHint: 'बंद करने के लिए ? या ESC दबाएँ',
  closeLabel: 'बंद करें',
  notYet: 'अभी नहीं',
  overview: 'आप खतरनाक अंतरिक्ष कचरे को उपग्रहों से टकराने से पहले साफ़ कर रहे हैं। स्कैन के लिए S दबाएँ, मिले टुकड़े पर जाल फेंकने के लिए N (A से पास जाएँ); हर पकड़ पर क्रेडिट मिलते हैं, जिनसे अपग्रेड और ज़्यादा जाल मिलते हैं।',
  groups: { start: 'यहाँ से शुरू', daughters: 'बेटी यान', ship: 'यान और दृश्य', stuck: 'अटक गए?', advanced: 'उन्नत' },
  chips: {
    zoom: ['व्हील · पिंच'], touch: ['टैप · दबाए रखें'], turn_pad: ['टर्न पैड'], turn_view: ['खींचें'], inspect: ['इशारा · क्लिक'],
  },
  rows: {
    zoom: 'ज़ूम इन / आउट',
    touch: 'टच: स्कैन / कार्रवाई',
    turn: 'यान घुमाएँ',
    turn_pad: 'यान घुमाएँ (टच, नीचे बाएँ)',
    scan: 'स्कैन',
    net: 'जाल फेंकें',
    fly: 'लक्ष्य तक उड़ें (चालू / बंद)',
    select: 'बेटी यान चुनें',
    launch_d: 'चुना बेटी यान छोड़ें',
    pair: 'चिह्नित जोड़ी छोड़ें',
    reel: 'चुना बेटी यान खींचें',
    next_tool: 'अगला औज़ार',
    use_tool: 'औज़ार इस्तेमाल करें',
    move_catch: 'पकड़ को रेडिएटर पर ले जाएँ',
    view_mother: 'मदर शिप का दृश्य',
    next_target: 'अगला लक्ष्य',
    main_action: 'मुख्य क्रिया',
    back: 'पीछे',
    pause: 'रुकें',
    upgrades: 'अपग्रेड (आपूर्ति पड़ाव पर खरीदें)',
    upgrades_map: 'अपग्रेड (आपूर्ति उपग्रह से खरीदें)',
    info: 'जानकारी',
    journal: 'जर्नल',
    radiator_out: 'रेडिएटर भुजाएँ बाहर / अंदर',
    struts: 'भुजाएँ बाहर / अंदर (चुनी / सभी)',
    wings: 'सोलर पंख बाहर / अंदर',
    stuck_scan: 'पकड़ने को कुछ नहीं? स्कैन करें',
    stuck_fly: 'जाल नहीं छूटता? पास जाएँ',
    stuck_hot: 'बहुत गरम? रेडिएटर खोलें',
    stuck_empty: 'क्षेत्र खाली? LEO पर Space दबाएँ',
    turn_view: 'दृश्य घुमाएँ',
    drawer: 'टच: दराज़ के नीचे दो बार टैप',
    hold_rad: 'रेडिएटर 180° पर',
    wide_scan: 'चौड़ा स्कैन',
    next_part: 'मलबे का अगला हिस्सा',
    laser: 'दबाए रखें: लेज़र घुमाव घटाए',
    nose_catch: 'नाक की पकड़ छोड़ें',
    throttle: 'थ्रॉटल कम / ज़्यादा',
    power_line: 'पावर लाइन चुनें',
    power_adj: 'पावर कम / ज़्यादा',
    tether: 'बिजली की रस्सी बाहर / अंदर',
    launch_all: 'सब छोड़ें, हर टुकड़े पर एक',
    send_all: 'सबको सबसे अच्छे टुकड़ों पर भेजें',
    launch_speed: 'छोड़ने की गति कम / ज़्यादा',
    circle: 'लक्ष्य का चक्कर',
    range: 'पास / दूर',
    change_tool: 'अगला औज़ार (DAUGHTERS पंक्ति)',
    reel_all: 'सभी बेटी यान खींचें',
    reel_fast: 'दबाए रखें: तेज़ खींचें',
    cut: 'रस्सी काटें',
    burn: 'पकड़ को जलाएँ',
    inspect: 'हिस्सा जाँचें / अपग्रेड करें',
    panels: 'कम / ज़्यादा पैनल',
    cities: 'शहर / तारामंडल',
    info_panes: 'लक्ष्य जानकारी / लक्ष्य पैनल',
    radio: 'रेडियो लॉग',
    nav: 'नेव बॉल',
    big_catch: 'बड़ी पकड़: क्या करें चुनें',
    furnace: 'भट्ठी (बनी नहीं)',
    thruster_metal: 'थ्रस्टर धातु',
    net_sweep: 'जाल से सफ़ाई',
    dev_auto: 'डेव: ऑटो-प्ले',
  },
};

const TA = {
  title: 'விசைகளும் கட்டுப்பாடுகளும்',
  closeHint: 'மூட ? அல்லது ESC அழுத்தவும்',
  closeLabel: 'மூடு',
  notYet: 'இன்னும் இல்லை',
  overview: 'ஆபத்தான விண்வெளிக் குப்பையைச் செயற்கைக்கோள்களில் மோதும் முன் அகற்றுகிறீர்கள். ஸ்கேன் செய்ய S, கண்ட துண்டின் மீது வலை ஏவ N (A அருகில் கொண்டுசெல்லும்); ஒவ்வொரு பிடிப்புக்கும் கிரெடிட் கிடைக்கும், அதில் மேம்பாடுகளும் கூடுதல் வலைகளும் வாங்கலாம்.',
  groups: { start: 'இங்கே தொடங்குங்கள்', daughters: 'மகள் கலங்கள்', ship: 'கலமும் காட்சிகளும்', stuck: 'சிக்கலா?', advanced: 'மேம்பட்டவை' },
  chips: {
    zoom: ['சக்கரம் · பிஞ்ச்'], touch: ['தட்டு · அழுத்திப்பிடி'], turn_pad: ['திருப்பு பேட்'], turn_view: ['இழு'], inspect: ['சுட்டு · கிளிக்'],
  },
  rows: {
    zoom: 'பெரிதாக்கு / சிறிதாக்கு',
    touch: 'தொடுதல்: ஸ்கேன் / செயல்கள்',
    turn: 'கலத்தைத் திருப்பு',
    turn_pad: 'கலத்தைத் திருப்பு (தொடு, கீழ் இடது)',
    scan: 'ஸ்கேன்',
    net: 'வலை ஏவு',
    fly: 'இலக்கை நோக்கிப் பற (இயக்கு / நிறுத்து)',
    select: 'மகள் கலத்தைத் தேர்வுசெய்',
    launch_d: 'தேர்ந்த மகள் கலத்தை ஏவு',
    pair: 'குறித்த இணையை ஏவு',
    reel: 'தேர்ந்த மகள் கலத்தை இழு',
    next_tool: 'அடுத்த கருவி',
    use_tool: 'கருவியைப் பயன்படுத்து',
    move_catch: 'பிடிப்பை ரேடியேட்டருக்கு மாற்று',
    view_mother: 'தாய் கலக் காட்சி',
    next_target: 'அடுத்த இலக்கு',
    main_action: 'முதன்மைச் செயல்',
    back: 'பின்',
    pause: 'இடைநிறுத்து',
    upgrades: 'மேம்பாடு (நிறுத்தத்தில் வாங்கு)',
    upgrades_map: 'மேம்பாடு (செயற்கைக்கோளில் வாங்கு)',
    info: 'தகவல்',
    journal: 'நாட்குறிப்பு',
    radiator_out: 'ரேடியேட்டர் கம்புகள் வெளியே / உள்ளே',
    struts: 'கம்புகள் வெளியே / உள்ளே (தேர்ந்தவை / எல்லாம்)',
    wings: 'சூரியச் சிறகுகள் வெளியே / உள்ளே',
    stuck_scan: 'பிடிக்க எதுவும் இல்லையா? ஸ்கேன் செய்',
    stuck_fly: 'வலை போகவில்லையா? அருகில் செல்',
    stuck_hot: 'மிகச் சூடா? ரேடியேட்டரைத் திற',
    stuck_empty: 'களம் காலியா? LEO-வில் Space அழுத்து',
    turn_view: 'காட்சியைத் திருப்பு',
    drawer: 'தொடுதல்: இழுப்பறை அடியில் இருமுறை தட்டு',
    hold_rad: 'ரேடியேட்டர்கள் 180° க்கு',
    wide_scan: 'அகல ஸ்கேன்',
    next_part: 'குப்பையின் அடுத்த பகுதி',
    laser: 'பிடித்திரு: லேசர் சுழற்சியைக் குறைக்கும்',
    nose_catch: 'மூக்குப் பிடிப்பை விடு',
    throttle: 'உந்துவிசை குறை / கூட்டு',
    power_line: 'மின் இணைப்பைத் தேர்வுசெய்',
    power_adj: 'மின்சாரம் குறை / கூட்டு',
    tether: 'மின் கயிறு வெளியே / உள்ளே',
    launch_all: 'அனைத்தையும் ஏவு, துண்டுக்கு ஒன்று',
    send_all: 'அனைத்தையும் சிறந்த துண்டுகளுக்கு அனுப்பு',
    launch_speed: 'ஏவு வேகம் குறை / கூட்டு',
    circle: 'இலக்கைச் சுற்று',
    range: 'அருகில் / தொலைவில்',
    change_tool: 'அடுத்த கருவி (DAUGHTERS வரிசை)',
    reel_all: 'அனைத்து மகள் கலங்களையும் இழு',
    reel_fast: 'பிடித்திரு: வேகமாக இழு',
    cut: 'கயிற்றை வெட்டு',
    burn: 'பிடிப்பை எரி',
    inspect: 'பகுதியைப் பார் / மேம்படுத்து',
    panels: 'குறைவான / அதிக பலகைகள்',
    cities: 'நகரங்கள் / விண்மீன் கூட்டங்கள்',
    info_panes: 'இலக்குத் தகவல் / இலக்குப் பலகைகள்',
    radio: 'வானொலிப் பதிவு',
    nav: 'வழிகாட்டிப் பந்து',
    big_catch: 'பெரிய பிடிப்பு: செய்வதைத் தேர்வுசெய்',
    furnace: 'உலை (கட்டப்படவில்லை)',
    thruster_metal: 'உந்து இயந்திர உலோகம்',
    net_sweep: 'வலைத் துடைப்பு',
    dev_auto: 'Dev: தானியங்கி ஆட்டம்',
  },
};

// ── The FAQ ("Questions", owner 2026-10-28, DECISIONS row "Help") ───────────────────────────────────────────────────────
// English lives in HOTKEY_GROUPS (the `faq` group's `items`); only the link label is here. Every other language holds the
// group title, the link label and a question and an answer for each item id. They sit in this one section (not inside the
// language blocks above) and are merged into the blocks by `withFaq` below, so a reviewer editing a block's rows never
// touches them. Model-made like the rest (REVIEW STATUS above). Numerals stay digits; a missing or empty string → English.
const FAQ_LINK_EN = 'More in the Tech library';

const FAQ_TEXT = {
  th: {
    title: 'คำถาม',
    link: 'ดูเพิ่มในคลังเทคโนโลยี',
    items: {
      faq_what: { q: 'Space Cowboy คืออะไร?', a: 'เกมที่คุณบังคับดาวเทียมไปเก็บขยะอวกาศ ก่อนที่มันจะชนดาวเทียมดวงอื่น' },
      faq_real: { q: 'ดาวเทียมนี้มีจริงไหม?', a: 'ยังไม่มี เกมนี้ทดสอบแบบดาวเทียมก่อนที่ใครจะสร้างจริง โดยใช้ฟิสิกส์จริง' },
      faq_win: { q: 'ชนะได้อย่างไร?', a: 'จับขยะให้ได้ 60 ชิ้น: 12 ภารกิจ ภารกิจละ 5 ชิ้น' },
      faq_daughters: { q: 'ยานลูกคืออะไร?', a: 'ยานช่วย 4 ลำที่ผูกสายยาว ไปจับขยะชิ้นเล็กหรืออยู่ไกลกว่า ช่วยประหยัดแก๊สของยานใหญ่' },
      faq_fuel: { q: 'ทำไมเชื้อเพลิงจึงสำคัญนัก?', a: 'แก๊สเครื่องยนต์ไม่เติมเอง จึงควรบินเส้นทางสั้น ๆ จะประหยัดแก๊ส ซื้อเพิ่มได้ตอนเติมเสบียง' },
      faq_after: { q: 'ขยะที่จับได้ไปไหนต่อ?', a: 'ถูกเก็บไว้ที่ปลายแผงระบายความร้อนหรือบนยานลูก ระหว่างเดินทางไปสนามถัดไป เตาหลอมเล็ก ๆ จะหลอมมัน' },
      faq_hot: { q: 'ทำไมยานของฉันร้อน?', a: 'แสงอาทิตย์ เครื่องยนต์ และมอเตอร์ล้วนสร้างความร้อน และในอวกาศไม่มีอากาศช่วยระบาย แผงระบายความร้อนจะเปิดเพื่อปล่อยความร้อนออก' },
      faq_crash: { q: 'ยานชนได้ไหม?', a: 'ได้ เมื่อการฝึกจบแล้ว ยานหลบขยะส่วนใหญ่เองได้ ยกเว้นชิ้นที่คุณกำลังไล่จับ' },
      faq_credits: { q: 'เครดิตใช้ซื้ออะไร?', a: 'อัปเกรด แหเพิ่ม และแก๊สเครื่องยนต์ ซื้อได้ตอนเติมเสบียงหลังจบภารกิจ' },
      faq_free: { q: 'เล่นฟรีไหม?', a: 'ฟรี เครดิตเป็นเงินในเกม และไม่มีอะไรในเกมที่ใช้เงินจริง' },
      faq_beta: { q: 'เกมเสร็จสมบูรณ์แล้วหรือยัง?', a: 'ยังไม่เสร็จ Space Cowboy เป็นเวอร์ชันทดสอบช่วงแรก (เบตา) และยังไม่เปิดให้คนทั่วไปเล่น' },
      faq_save: { q: 'เกมบันทึกไหม?', a: 'บันทึก ในเบราว์เซอร์บนอุปกรณ์เครื่องนี้ เครดิต อัปเกรด และความคืบหน้าของภารกิจจะอยู่จนกว่าคุณจะเริ่มเกมใหม่' },
      faq_devices: { q: 'เล่นบนอะไรได้บ้าง?', a: 'คอมพิวเตอร์ที่มีคีย์บอร์ด หรือ iPad ที่ถือแนวนอน หลังเข้าครั้งแรกแล้วเล่นได้โดยไม่ต้องใช้อินเทอร์เน็ต' },
    },
  },
  ja: {
    title: 'よくある質問',
    link: 'テックライブラリでもっと見る',
    items: {
      faq_what: { q: 'Space Cowboy とは?', a: '衛星を操縦して、宇宙ゴミが他の衛星にぶつかる前に片付けるゲームです。' },
      faq_real: { q: '衛星は実在しますか?', a: 'まだありません。このゲームは、誰かが作る前に、本物の物理法則で衛星の設計を試します。' },
      faq_win: { q: 'どうすれば勝てますか?', a: 'ゴミを 60 個捕まえます。5 個ずつの 12 ミッションです。' },
      faq_daughters: { q: '子機とは?', a: '長い線につながった 4 機の助っ人です。小さいゴミや遠いゴミを担当し、大きな船のガスを節約します。' },
      faq_fuel: { q: 'なぜ燃料が大事なのですか?', a: 'エンジンのガスは自然には増えません。短い移動なら節約できます。補給のときに買い足せます。' },
      faq_after: { q: '捕まえたゴミはどうなりますか?', a: 'ラジエーターの先か子機に載せておきます。次の宙域へ向かう間に、小さな炉が溶かします。' },
      faq_hot: { q: '船はなぜ熱くなりますか?', a: '日光、エンジン、モーターが熱を出し、宇宙には冷やす空気がありません。ラジエーターを開いて熱を逃がします。' },
      faq_crash: { q: 'ぶつかることはありますか?', a: 'あります。練習が終わってからです。船はほとんどのゴミを自動でよけますが、狙っている 1 個はよけません。' },
      faq_credits: { q: 'クレジットは何に使いますか?', a: 'アップグレード、ネットの追加、エンジンのガスです。ミッションの後の補給で買います。' },
      faq_free: { q: '無料ですか?', a: 'はい。クレジットはゲーム内のお金で、ゲームの中に本物のお金がかかるものはありません。' },
      faq_beta: { q: '完成していますか?', a: 'まだです。Space Cowboy は初期のテスト版 (ベータ) で、まだ一般には公開されていません。' },
      faq_save: { q: 'セーブされますか?', a: 'はい。この端末のブラウザに保存されます。クレジット、アップグレード、ミッションの進み具合は、新しいゲームを始めるまで残ります。' },
      faq_devices: { q: '何で遊べますか?', a: 'キーボード付きのコンピューターか、横向きにした iPad です。最初に開いた後は、ネットなしで動きます。' },
    },
  },
  es: {
    title: 'Preguntas',
    link: 'Más en la biblioteca técnica',
    items: {
      faq_what: { q: '¿Qué es Space Cowboy?', a: 'Un juego en el que pilotas un satélite que limpia basura espacial antes de que choque con otros satélites.' },
      faq_real: { q: '¿Es real el satélite?', a: 'Todavía no. El juego prueba un diseño de satélite antes de que alguien lo construya, con física real.' },
      faq_win: { q: '¿Cómo se gana?', a: 'Captura 60 piezas de basura: 12 misiones de 5 capturas cada una.' },
      faq_daughters: { q: '¿Qué son las hijas?', a: 'Cuatro naves auxiliares unidas por cables largos. Van tras la basura más pequeña o lejana y ahorran gas de la nave grande.' },
      faq_fuel: { q: '¿Por qué importa tanto el combustible?', a: 'El gas del motor no se rellena solo, así que los viajes cortos lo ahorran. Puedes comprar más al reabastecerte.' },
      faq_after: { q: '¿Qué pasa con la basura que capturo?', a: 'Se guarda en la punta de un radiador o en una hija. En el viaje al siguiente campo, hornos pequeños la funden.' },
      faq_hot: { q: '¿Por qué se calienta mi nave?', a: 'El sol, los propulsores y los motores dan calor, y en el espacio no hay aire que enfríe. Los radiadores se abren para soltarlo.' },
      faq_crash: { q: '¿Puedo chocar?', a: 'Sí, cuando termina el entrenamiento. La nave esquiva sola casi toda la basura, pero no la pieza que persigues.' },
      faq_credits: { q: '¿En qué gasto los créditos?', a: 'En mejoras, más redes y gas para el motor. Se compran al reabastecerte después de una misión.' },
      faq_free: { q: '¿Es gratis?', a: 'Sí. Los créditos son dinero del juego, y nada en el juego cuesta dinero real.' },
      faq_beta: { q: '¿Está terminado?', a: 'Todavía no. Space Cowboy es una versión de prueba temprana (una beta) y aún no está abierta al público.' },
      faq_save: { q: '¿El juego guarda?', a: 'Sí, en tu navegador y en este dispositivo. Los créditos, las mejoras y el avance de misiones se quedan hasta que empieces una partida nueva.' },
      faq_devices: { q: '¿En qué puedo jugar?', a: 'En un ordenador con teclado o en un iPad en horizontal. Tras tu primera visita funciona sin internet.' },
    },
  },
  pt: {
    title: 'Perguntas',
    link: 'Mais na biblioteca técnica',
    items: {
      faq_what: { q: 'O que é Space Cowboy?', a: 'Um jogo em que você pilota um satélite que limpa lixo espacial antes que ele atinja outros satélites.' },
      faq_real: { q: 'O satélite é real?', a: 'Ainda não. O jogo testa um projeto de satélite antes de alguém construí-lo, com física real.' },
      faq_win: { q: 'Como eu ganho?', a: 'Capture 60 peças de lixo: 12 missões de 5 capturas cada.' },
      faq_daughters: { q: 'O que são as filhas?', a: 'Quatro naves auxiliares presas por cabos longos. Elas vão atrás do lixo menor ou mais distante e poupam o gás da nave grande.' },
      faq_fuel: { q: 'Por que o combustível importa tanto?', a: 'O gás do motor não se recarrega sozinho, então viagens curtas o poupam. Você pode comprar mais ao reabastecer.' },
      faq_after: { q: 'O que acontece com o lixo que capturo?', a: 'Ele fica na ponta de um radiador ou numa filha. Na viagem ao próximo campo, fornos pequenos o derretem.' },
      faq_hot: { q: 'Por que minha nave esquenta?', a: 'Sol, motores e propulsores geram calor, e no espaço não há ar para esfriar. Os radiadores abrem para soltar o calor.' },
      faq_crash: { q: 'Posso bater?', a: 'Sim, depois que o treinamento termina. A nave desvia sozinha da maior parte do lixo, mas não da peça que você persegue.' },
      faq_credits: { q: 'Em que gasto os créditos?', a: 'Em melhorias, mais redes e gás do motor. Você compra ao reabastecer depois de uma missão.' },
      faq_free: { q: 'É grátis?', a: 'Sim. Os créditos são dinheiro do jogo, e nada no jogo custa dinheiro de verdade.' },
      faq_beta: { q: 'Está pronto?', a: 'Ainda não. Space Cowboy é uma versão de teste inicial (um beta) e ainda não está aberta ao público.' },
      faq_save: { q: 'O jogo salva?', a: 'Sim, no seu navegador, neste dispositivo. Créditos, melhorias e progresso das missões ficam até você começar um jogo novo.' },
      faq_devices: { q: 'Em que posso jogar?', a: 'Num computador com teclado ou num iPad na horizontal. Depois da primeira visita, funciona sem internet.' },
    },
  },
  hi: {
    title: 'सवाल',
    link: 'टेक लाइब्रेरी में और देखें',
    items: {
      faq_what: { q: 'Space Cowboy क्या है?', a: 'एक खेल जिसमें आप उपग्रह उड़ाते हैं, जो अंतरिक्ष कचरे को दूसरे उपग्रहों से टकराने से पहले साफ़ करता है।' },
      faq_real: { q: 'क्या यह उपग्रह असली है?', a: 'अभी नहीं। खेल असली भौतिकी से उपग्रह के डिज़ाइन को परखता है, किसी के उसे बनाने से पहले।' },
      faq_win: { q: 'मैं कैसे जीतूँ?', a: 'कचरे के 60 टुकड़े पकड़ें: 12 मिशन, हर मिशन में 5 पकड़।' },
      faq_daughters: { q: 'बेटी यान क्या हैं?', a: 'लंबी डोरियों वाले चार सहायक यान। वे छोटे या दूर के कचरे के पीछे जाते हैं, जिससे बड़े यान की गैस बचती है।' },
      faq_fuel: { q: 'ईंधन इतना ज़रूरी क्यों है?', a: 'इंजन की गैस अपने आप नहीं भरती, इसलिए छोटे सफ़र उसे बचाते हैं। आपूर्ति के समय और खरीद सकते हैं।' },
      faq_after: { q: 'पकड़े गए कचरे का क्या होता है?', a: 'वह रेडिएटर की नोक पर या बेटी यान पर रहता है। अगले क्षेत्र के सफ़र में छोटी भट्ठियाँ उसे पिघला देती हैं।' },
      faq_hot: { q: 'मेरा यान गरम क्यों होता है?', a: 'धूप, इंजन और मोटर गरमी बनाते हैं, और अंतरिक्ष में ठंडा करने वाली हवा नहीं है। रेडिएटर गरमी बाहर निकालने के लिए खुलते हैं।' },
      faq_crash: { q: 'क्या मैं टकरा सकता हूँ?', a: 'हाँ, प्रशिक्षण खत्म होने के बाद। यान ज़्यादातर कचरे से खुद बचता है, पर उस टुकड़े से नहीं जिसका आप पीछा कर रहे हैं।' },
      faq_credits: { q: 'क्रेडिट किस पर खर्च करूँ?', a: 'अपग्रेड, ज़्यादा जाल और इंजन की गैस पर। इन्हें मिशन के बाद आपूर्ति के समय खरीदें।' },
      faq_free: { q: 'क्या यह मुफ़्त है?', a: 'हाँ। क्रेडिट खेल का पैसा हैं, और खेल में कुछ भी असली पैसे का नहीं है।' },
      faq_beta: { q: 'क्या यह पूरा हो चुका है?', a: 'अभी नहीं। Space Cowboy एक शुरुआती परीक्षण संस्करण (बीटा) है, और अभी आम जनता के लिए खुला नहीं है।' },
      faq_save: { q: 'क्या खेल सेव होता है?', a: 'हाँ, इस डिवाइस के आपके ब्राउज़र में। क्रेडिट, अपग्रेड और मिशन की प्रगति नया खेल शुरू करने तक बनी रहती है।' },
      faq_devices: { q: 'मैं किस पर खेल सकता हूँ?', a: 'कीबोर्ड वाले कंप्यूटर पर, या आड़े पकड़े iPad पर। पहली बार खोलने के बाद यह बिना इंटरनेट चलता है।' },
    },
  },
  ta: {
    title: 'கேள்விகள்',
    link: 'தொழில்நுட்ப நூலகத்தில் மேலும்',
    items: {
      faq_what: { q: 'Space Cowboy என்றால் என்ன?', a: 'செயற்கைக்கோளைச் செலுத்தி, விண்வெளிக் குப்பை மற்ற செயற்கைக்கோள்களில் மோதும் முன் அகற்றும் விளையாட்டு.' },
      faq_real: { q: 'இந்தச் செயற்கைக்கோள் உண்மையானதா?', a: 'இன்னும் இல்லை. யாரும் கட்டுவதற்கு முன், உண்மையான இயற்பியலுடன் செயற்கைக்கோள் வடிவமைப்பை இந்த விளையாட்டு சோதிக்கிறது.' },
      faq_win: { q: 'எப்படி வெல்வது?', a: '60 குப்பைத் துண்டுகளைப் பிடியுங்கள்: 12 பணிகள், ஒவ்வொன்றிலும் 5 பிடிப்புகள்.' },
      faq_daughters: { q: 'மகள் கலங்கள் என்றால் என்ன?', a: 'நீண்ட கயிறுகளில் உள்ள நான்கு உதவிக் கலங்கள். சிறிய அல்லது தொலைவில் உள்ள குப்பையைத் தேடிப் போய், பெரிய கலத்தின் வாயுவைச் சேமிக்கின்றன.' },
      faq_fuel: { q: 'எரிபொருள் ஏன் இவ்வளவு முக்கியம்?', a: 'இயந்திர வாயு தானாக நிரம்பாது, அதனால் குறுகிய பயணங்கள் அதைச் சேமிக்கும். மறுபொருள் நிரப்பும்போது மேலும் வாங்கலாம்.' },
      faq_after: { q: 'நான் பிடிக்கும் குப்பைக்கு என்ன ஆகும்?', a: 'அது ரேடியேட்டர் முனையிலோ மகள் கலத்திலோ இருக்கும். அடுத்த களத்துக்கான பயணத்தில் சிறிய உலைகள் அதை உருக்கும்.' },
      faq_hot: { q: 'என் கலம் ஏன் சூடாகிறது?', a: 'சூரிய ஒளி, இயந்திரங்கள், மோட்டார்கள் வெப்பம் தருகின்றன; விண்வெளியில் குளிர்விக்கக் காற்றும் இல்லை. வெப்பத்தை வெளியேற்ற ரேடியேட்டர்கள் திறக்கும்.' },
      faq_crash: { q: 'நான் மோத முடியுமா?', a: 'முடியும், பயிற்சி முடிந்த பிறகு. கலம் பெரும்பாலான குப்பையைத் தானே தவிர்க்கும்; ஆனால் நீங்கள் துரத்தும் துண்டை அல்ல.' },
      faq_credits: { q: 'கிரெடிட்டை எதற்குச் செலவிடுவது?', a: 'மேம்பாடுகள், கூடுதல் வலைகள், இயந்திர வாயு. பணிக்குப் பிறகு மறுபொருள் நிரப்பும்போது வாங்கலாம்.' },
      faq_free: { q: 'இது இலவசமா?', a: 'ஆம். கிரெடிட் விளையாட்டுப் பணம்; விளையாட்டில் எதற்கும் உண்மையான பணம் தேவையில்லை.' },
      faq_beta: { q: 'இது முடிந்துவிட்டதா?', a: 'இன்னும் இல்லை. Space Cowboy ஒரு ஆரம்பச் சோதனைப் பதிப்பு (பீட்டா); பொதுமக்களுக்கு இன்னும் திறக்கப்படவில்லை.' },
      faq_save: { q: 'விளையாட்டு சேமிக்குமா?', a: 'ஆம், இந்தச் சாதனத்தில் உங்கள் உலாவியில். கிரெடிட், மேம்பாடுகள், பணி முன்னேற்றம் புதிய விளையாட்டு தொடங்கும் வரை இருக்கும்.' },
      faq_devices: { q: 'எதில் விளையாடலாம்?', a: 'விசைப்பலகை உள்ள கணினியில், அல்லது படுக்கையாகப் பிடித்த iPad-இல். முதல் வருகைக்குப் பிறகு இணையம் இல்லாமலும் இயங்கும்.' },
    },
  },
};

/** A language block plus its FAQ: the group title joins `groups` (the page reads `groups.faq`), the rest goes in `faq`. */
function withFaq(block, code) {
  const f = FAQ_TEXT[code];
  if (!f) return { ...block, faq: { link: FAQ_LINK_EN, items: {} } };
  return { ...block, groups: { ...block.groups, faq: f.title }, faq: { link: f.link, items: f.items } };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** @type {Readonly<Record<string, any>>} one block per language code (`en` holds only the strings not in HOTKEY_GROUPS) */
export const HELP_TEXT = deepFreeze({
  en: withFaq(EN, 'en'), th: withFaq(TH, 'th'), ja: withFaq(JA, 'ja'), es: withFaq(ES, 'es'),
  pt: withFaq(PT, 'pt'), hi: withFaq(HI, 'hi'), ta: withFaq(TA, 'ta'),
});

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * The block for a language code, every missing or empty string taken from English. Unknown code, no code, or a
 * non-string: the English block. The three maps (`groups`, `rows`, `chips`) come back as they are in the language's
 * block (empty for English); the overlay falls back to the English table row by row.
 * @param {string} [code]
 * @returns {{title:string, closeHint:string, closeLabel:string, notYet:string, overview:string,
 *   groups:Record<string,string>, rows:Record<string,string>, chips:Record<string,string[]>,
 *   faq:{link:string, items:Record<string,{q:string,a:string}>}}}
 */
export function helpTextFor(code) {
  const block = (typeof code === 'string' && Object.prototype.hasOwnProperty.call(HELP_TEXT, code)) ? HELP_TEXT[code] : EN;
  const out = {};
  for (const k of HELP_SCALAR_KEYS) out[k] = isText(block[k]) ? block[k] : EN[k];
  out.groups = block.groups || {};
  out.rows = block.rows || {};
  out.chips = block.chips || {};
  // The FAQ: the link label (English when missing or empty) and the per-item questions and answers (the overlay falls
  // back to the English item row by row).
  const faq = block.faq || {};
  out.faq = { link: isText(faq.link) ? faq.link : FAQ_LINK_EN, items: faq.items || {} };
  return out;
}

export default HELP_TEXT;
