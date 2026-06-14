// ============================================================
// 呪文詠唱バトル — ollama 判定モジュール(敵ターゲティング拡張版)
//
// 元の spell-judge.js を「敵リストを見て、叫びがどの敵にどれだけ効くか」
// まで判定するよう拡張した。音量(loudness)はクライアント側で最終ダメージに
// 乗算するため、LLM には呪文そのものの強さ(base power)だけを返させる。
//
// 使い方:
//   const res = await judgeSpell(spellText, { enemies, loudness });
//   // res = { spell_name, element, power, target_id, narration }
// ============================================================

// LLMエンドポイントは judge(プレイヤー呪文判定) と enemy(敵攻撃生成) を分けて指定できる。
//   既定は両方 gx10-a9c0.local:11434 の gpt-oss:20b。別マシンに分けると競合が減り安定する。
// クエリ上書き: ?judge=URL&judgeModel=... / ?enemy=URL&enemyModel=...
//   ?ollama=&?model= は両方に効く一括指定(後方互換)。
// ollama直: .../api/chat  /  OpenAI互換: .../v1/chat/completions — パスで自動判別。
// 実測 gpt-oss:20b(GB10) warm ~5s。OpenAI互換(例 :8000/v1/chat/completions, deepseek系)も ?judge= で接続可。
const params = new URLSearchParams(location.search);
const pick = (k, def) => params.get(k) || params.get("ollama") || def;
const pickModel = (k, def) => params.get(k) || params.get("model") || def;

export const JUDGE_ENDPOINT = pick("judge", "http://gx10-a9c0.local:11434/api/chat");
const JUDGE_MODEL = pickModel("judgeModel", "gpt-oss:20b");
export const ENEMY_ENDPOINT = pick("enemy", "http://gx10-a9c0.local:11434/api/chat");
const ENEMY_MODEL = pickModel("enemyModel", "gpt-oss:20b");
const isOpenAI = (url) => /\/v1\/|\/chat\/completions/.test(url);

export const ELEMENTS = ["火", "水", "雷", "風", "土", "闇", "氷", "毒", "鋼", "ヒタイ"];

const SYSTEM_PROMPT = `あなたは「呪文詠唱バトル」の審判AIです。
画面に複数の敵がいます。プレイヤーが叫んだ呪文(音声認識テキスト)を受け取り、
どの敵にどの属性でどれくらいの威力で当たるかを、ノリ良く威力大きめに判定します。

# ルール
- 入力がどんなに意味不明でも、でたらめでも、絶対に「無効」とは言わない。威力で必殺技に変換する。
- 認識ミスで変な言葉でも、むしろ面白い呪文名として扱う。
- 叫びの中の敵の名前・位置(ひだり/みぎ/うえ/した/まんなか)・色・属性から、当てる敵を1体選ぶ。
  敵の名前は漢字/ひらがな/カタカナのどれで言われても、各敵の name と aka(別名リスト) の
  「読み」で一致を判断する(例: 「鳥」=「とり」=「トリ」は同じ敵)。
  該当が曖昧なら、一番手前(HPが高い/先頭)の敵を選ぶ。必ず1体は選ぶ。
- 威力(power)は呪文そのものの強さ。声の大きさは別で処理するので考慮しない。
- style(カッコよさ)を 1〜100 で採点する。敵の見た目・名前・弱点など特徴を踏まえた
  独創的で熱い詠唱・必殺技口上ほど高得点。ただの単語・ベタな一言は低め(20〜40)。
  特徴に刺さるキメ台詞は 80〜100。これが高いほどダメージが伸びる。
- 出力は必ず下記JSONのみ。前置き・説明・マークダウンは一切書かない。

# 属性(elementから1つ選ぶ)
"火" "水" "雷" "風" "土" "闇" "氷" "毒" "鋼" "ヒタイ"

# 出力JSON形式
{
  "spell_name": "呪文名(8文字以内・カタカナ中心)",
  "element": "属性",
  "power": 整数(0〜9999),
  "target_id": "当てる敵のid(enemiesのidから1つ)",
  "style": 整数(1〜100、敵の特徴に合った独創的でカッコいい詠唱ほど高い),
  "narration": "読み上げ用ナレーション。30文字以内。ひらがな・カタカナ多め。最後は「のダメージ!」で締める。"
}

# 例
敵: [{"id":"e1","name":"とり","pos":"みぎうえ","element":"風","hp":1200},{"id":"e2","name":"ひのたま","pos":"まんなか","element":"火","hp":2000}]
叫び: 大空の覇者よ、雷光となりて墜ちろ！
出力: {"spell_name":"ライメイ墜","element":"雷","power":2400,"target_id":"e1","style":92,"narration":"おおぞらのトリにライメイ! 2400のダメージ!"}`;

// ------------------------------------------------------------
// 本体
// ------------------------------------------------------------
export async function judgeSpell(spellText, { enemies = [], loudness = 0.5, focusId = null } = {}) {
  // 別名(漢字・カタカナ)も渡して、STTが漢字で返してもLLMが読みで対象を選べるように
  const roster = enemies.map((e) => ({
    id: e.id, name: e.name, aka: e.aliases || [], pos: e.posLabel, element: e.element, hp: e.hp,
  }));
  const userMsg = `敵: ${JSON.stringify(roster)}\n叫び: ${spellText}`;
  const parsed = await chatJSON(
    JUDGE_ENDPOINT, JUDGE_MODEL,
    [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }],
    8000,
  );
  if (!parsed) return fallback(spellText, enemies, focusId);
  return normalize(parsed, spellText, enemies, focusId);
}

// LLM を JSON モードで叩く共通ヘルパ。ollama / OpenAI互換 を自動判別。失敗は null。
async function chatJSON(endpoint, model, messages, timeoutMs = 8000) {
  const oai = isOpenAI(endpoint);
  // OpenAI互換(deepseek-v4-flash等): response_format 非対応サーバがあるので付けず、
  // max_tokens で巨大生成を防ぎ、reasoning_effort:low で詰める。JSONは安全側で safeParse 任せ。
  const body = oai
    ? { model, messages, temperature: 0.9, max_tokens: 400, reasoning_effort: "low" }
    : { model, messages, stream: false, format: "json", options: { temperature: 0.9 } };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error("LLM HTTP " + res.status);
    const data = await res.json();
    const raw = oai
      ? (data?.choices?.[0]?.message?.content ?? "")
      : (data?.message?.content ?? "");
    return safeParse(raw);
  } catch (e) {
    console.warn("[chatJSON] fail:", endpoint, e.message || e);
    return null;
  }
}

// ------------------------------------------------------------
// 敵の攻撃セリフをまとめて生成（ウェーブ湧き時に1回呼ぶ）
// 戻り: { [enemyId]: {attack_name, element, damage, narration} }
// 生成前/LLM落ちは呼び出し側が cannedAttack で埋める。
// ------------------------------------------------------------
const ENEMY_SYSTEM = `あなたは「呪文詠唱バトル」の敵キャラ実況AIです。
各敵がプレイヤーに放つ攻撃を、敵の属性に合わせてノリ良く作ります。

# ルール
- damage はプレイヤーへのダメージ。30〜260の整数（即死させない手加減）。
- element は各敵の属性をそのまま使う。
- narration はその敵が攻撃する短い実況。20文字以内、カタカナ・ひらがな多め、最後は「のダメージ!」で締める。
- attack_name は技名、8文字以内。
- 出力は必ず下記JSONのみ。前置き・説明は書かない。

# 出力JSON形式
{"attacks":[{"id":"敵id","attack_name":"技名","element":"属性","damage":整数,"narration":"実況"}]}`;

export async function enemyAttacks(enemies) {
  const roster = enemies.map((e) => ({ id: e.id, name: e.name, element: e.element }));
  const parsed = await chatJSON(
    ENEMY_ENDPOINT, ENEMY_MODEL,
    [{ role: "system", content: ENEMY_SYSTEM }, { role: "user", content: `敵: ${JSON.stringify(roster)}` }],
    8000,
  );
  const out = {};
  const arr = Array.isArray(parsed?.attacks) ? parsed.attacks : [];
  for (const a of arr) {
    const e = enemies.find((x) => x.id === a?.id);
    if (!e) continue;
    out[e.id] = {
      attack_name: (a.attack_name || e.name + "のいちげき").toString().slice(0, 12),
      element: ELEMENTS.includes(a.element) ? a.element : e.element,
      damage: clamp(Math.round(+a.damage || 80), 20, 320),
      narration: (a.narration || `${e.name}のこうげき! ダメージ!`).toString().slice(0, 30),
    };
  }
  return out;
}

// 属性別の定型攻撃（生成前/LLM落ち用）
export function cannedAttack(enemy) {
  const dmg = 60 + Math.floor((hashSeed(enemy.id + enemy.name) % 160));
  return {
    attack_name: `${enemy.name}のいちげき`.slice(0, 12),
    element: enemy.element,
    damage: dmg,
    narration: `${enemy.name}のこうげき! ${dmg}のダメージ!`.slice(0, 30),
  };
}

// format:"json" でもたまに前後にゴミが付くので念のため { } を拾う
function safeParse(s) {
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// 欠けたフィールドを埋め、LLMが何返しても落とさない
function normalize(p, src, enemies, focusId) {
  const power = Number.isFinite(+p.power) ? clamp(+p.power, 0, 9999) : 1200;
  const target = pickTarget(p.target_id, src, enemies, focusId);
  return {
    spell_name: (p.spell_name || src || "ナゾの呪文").toString().slice(0, 12),
    element: ELEMENTS.includes(p.element) ? p.element : "ヒタイ",
    power: Math.round(power),
    style: Number.isFinite(+p.style) ? clamp(Math.round(+p.style), 1, 100) : 50,
    target_id: target?.id ?? null,
    narration: (p.narration || `${Math.round(power)}のダメージ!`).toString().slice(0, 40),
    _fallback: false,
  };
}

// LLMの target_id が無効でも、叫び文からキーワードで敵を当てる
function pickTarget(id, src, enemies, focusId) {
  if (!enemies.length) return null;
  // カメラON時は照準(スコープ)が合っている敵が最優先。フォーカス外の敵には当たらない。
  let hit = enemies.find((e) => e.id === focusId);
  if (hit) return hit;
  // カメラOFF(focusId無し)は叫びの内容で狙う
  hit = enemies.find((e) => e.id === id);
  if (hit) return hit;
  hit = matchByKeyword(src, enemies);
  if (hit) return hit;
  // 最後の砦: HP最大の敵(=一番手前っぽい)
  return enemies.reduce((a, b) => (b.hp > a.hp ? b : a));
}

const POS_WORDS = {
  ひだり: "left", みぎ: "right", うえ: "top", した: "bottom", まんなか: "mid",
  左: "left", 右: "right", 上: "top", 下: "bottom", 真ん中: "mid", 中央: "mid",
};

// STTは漢字で返しがち＆ひらがな/カタカナ混在。かなをカタカナに寄せ記号を除いて比較。
// (漢字→かな変換は辞書が要るので、漢字は aliases 側で吸収する)
function kana(s) {
  return (s || "")
    .toString()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) // ひら→カタ
    .replace(/[\s・。、！!？?]/g, "");
}

function matchByKeyword(src, enemies) {
  const T = kana(src);
  // 名前・別名(漢字含む)を正規化して部分一致。長い名前を優先して誤爆を減らす。
  const cands = [];
  for (const e of enemies) {
    for (const form of [e.name, ...(e.aliases || [])]) {
      const k = kana(form);
      if (k && T.includes(k)) cands.push({ e, len: k.length });
    }
  }
  if (cands.length) return cands.sort((a, b) => b.len - a.len)[0].e;
  // 位置語での一致
  const wanted = new Set();
  for (const [w, tag] of Object.entries(POS_WORDS)) if (src && src.includes(w)) wanted.add(tag);
  if (wanted.size) {
    const byPos = enemies.find((e) => (e.posTags || []).some((t) => wanted.has(t)));
    if (byPos) return byPos;
  }
  return null;
}

// ollamaが落ちてても発表会を止めない保険判定
function fallback(src, enemies, focusId) {
  const power = 600 + Math.floor((hashSeed(src) % 3400));
  const target = pickTarget(null, src, enemies, focusId);
  const elem = ELEMENTS[hashSeed(src) % ELEMENTS.length];
  return {
    spell_name: (src || "ナゾの呪文").toString().slice(0, 12),
    element: elem,
    power,
    style: 45,
    target_id: target?.id ?? null,
    narration: `${(src || "ナゾ").toString().slice(0, 8)}! ${power}のダメージ!`,
    _fallback: true,
  };
}

// 同じ叫びは同じ結果に(乱数より発表で映える)
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < (s || "").length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
