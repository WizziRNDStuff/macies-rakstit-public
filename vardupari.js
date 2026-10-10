// Word pairs for "Lasi un atrodi" (atrodi.html) — reading comprehension with
// minimal pairs: two words that look/sound almost the same, different meaning.
//
// To add a pair, add one line: [["vārds", "emoji"], ["vārds", "emoji"]].
// Write words in lowercase with diacritics; the page applies the letter-case
// setting (shared with Vārdi). Only add a pair if BOTH words have a clear,
// unambiguous emoji — the picture is the only clue, there are no labels.
//
// Left out (no clear emoji — kept here so they're not re-added by guessing):
//   zīle  — no acorn emoji (🌰 is a chestnut), and "zīle" is also the bird
//   poga  — no button emoji (🔘 is a UI radio button)
//   pupa  — 🫘 is Emoji 14 (2021), shows as an empty box on older tablets
//   zeme  — 🌍 reads as "pasaule"/"planēta" rather than "zeme"
//   zupa  — 🍲 is a pot of stew, could be read as "katls"/"ēdiens"
//
// Notes: 🫐 (oga) is Emoji 13 (2020) and 🧊 (ledus) Emoji 12 (2019) — fine on
// Android 10–11+/iOS 13–14+. pīle/pile and lupa/lūpa train vowel length
// (ī/i, ū/u), the pairs Latvian readers use for it ("pile – pīle").
var WORD_PAIRS = [
  [["ola",   "🥚"], ["ota",   "🖌️"]],
  [["oga",   "🫐"], ["ola",   "🥚"]],
  [["pīle",  "🦆"], ["pele",  "🐭"]],
  [["pūce",  "🦉"], ["puķe",  "🌼"]],
  [["lapa",  "🍃"], ["lupa",  "🔍"]],
  [["māja",  "🏠"], ["kāja",  "🦵"]],
  [["lauva", "🦁"], ["laiva", "🛶"]],
  [["auss",  "👂"], ["auns",  "🐏"]],
  [["cūka",  "🐷"], ["kūka",  "🍰"]],
  [["zaķis", "🐰"], ["kaķis", "🐱"]],
  [["ķirsis", "🍒"], ["ķirbis", "🎃"]],
  [["ledus", "🧊"], ["medus", "🍯"]],
  [["karote", "🥄"], ["karte", "🗺️"]],
  [["pīle",  "🦆"], ["pile",  "💧"]],
  [["lupa",  "🔍"], ["lūpa",  "👄"]],
];
