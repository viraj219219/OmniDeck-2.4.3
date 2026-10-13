/**
 * BibleLanguageDetectionService — figures out what language a Bible
 * translation file is in, without requiring the file to say so explicitly.
 *
 * This exists because a perfectly valid Bible JSON/XML file may have no
 * `language` field at all — the importer (BibleImportService.js) used to
 * hard-require one and reject anything without it. This service is what
 * lets the importer instead *detect* the language and only fall back to
 * asking the teacher when detection is genuinely unconfident (see
 * PART 10 in the product spec this was built against: never show a raw
 * "missing language field" error to a teacher).
 *
 * Nothing here is Telugu-specific. Every language it knows about (see
 * SUPPORTED_LANGUAGES below) goes through the exact same evidence
 * pipeline; adding a new language is adding one entry to that table (plus,
 * optionally, a short vocabulary list for languages that share a script
 * with others), not writing new detection logic.
 *
 * detect() returns:
 *   {
 *     language: "Telugu" | null,
 *     languageCode: "te" | null,
 *     confidence: 0.98,
 *     source: "explicit-metadata" | "language-code" | "translation-metadata"
 *             | "filename" | "unicode-script" | "vocabulary" | "combined" | "none",
 *     ambiguous: false,
 *     candidates: [...]   // only populated when ambiguous — for a manual picker
 *   }
 *
 * Below CONFIDENCE_THRESHOLD, `ambiguous` is true and the caller (see
 * BibleImportService.pickAndImportBible) is expected to ask the teacher to
 * pick from `candidates` (or from the full SUPPORTED_LANGUAGES list)
 * rather than guessing or rejecting the file.
 */

export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * The language table. `code` is the ISO 639-1 code used internally once a
 * language is identified. `aliases` are alternate spellings/names matched
 * against explicit metadata, translation-name/title text, and filenames
 * (case-insensitive). `script` marks a Unicode block that, among this
 * supported set, uniquely identifies the language (so script evidence
 * alone can be high-confidence). `sharedScript` groups languages that use
 * the same block as each other (Devanagari, Latin) — script evidence for
 * those is deliberately capped lower on its own; see scoreUnicodeScript.
 */
export const SUPPORTED_LANGUAGES = [
  { name: "Telugu", code: "te", aliases: ["telugu"], script: "telugu" },
  { name: "Tamil", code: "ta", aliases: ["tamil"], script: "tamil" },
  { name: "Kannada", code: "kn", aliases: ["kannada"], script: "kannada" },
  { name: "Malayalam", code: "ml", aliases: ["malayalam"], script: "malayalam" },
  { name: "Bengali", code: "bn", aliases: ["bengali", "bangla"], script: "bengali" },
  { name: "Gujarati", code: "gu", aliases: ["gujarati"], script: "gujarati" },
  { name: "Punjabi", code: "pa", aliases: ["punjabi", "panjabi"], script: "gurmukhi" },
  { name: "Hindi", code: "hi", aliases: ["hindi"], sharedScript: "devanagari" },
  { name: "Marathi", code: "mr", aliases: ["marathi"], sharedScript: "devanagari" },
  { name: "Nepali", code: "ne", aliases: ["nepali"], sharedScript: "devanagari" },
  { name: "English", code: "en", aliases: ["english"], sharedScript: "latin" },
  { name: "French", code: "fr", aliases: ["french", "français", "francais"], sharedScript: "latin" },
  { name: "Spanish", code: "es", aliases: ["spanish", "español", "espanol", "castellano"], sharedScript: "latin" },
  { name: "Portuguese", code: "pt", aliases: ["portuguese", "português", "portugues"], sharedScript: "latin" },
  { name: "German", code: "de", aliases: ["german", "deutsch"], sharedScript: "latin" },
  { name: "Italian", code: "it", aliases: ["italian", "italiano"], sharedScript: "latin" },
];

const BY_NAME = new Map(SUPPORTED_LANGUAGES.map((l) => [l.name.toLowerCase(), l]));
const BY_CODE = new Map(SUPPORTED_LANGUAGES.map((l) => [l.code.toLowerCase(), l]));
const BY_ALIAS = new Map(SUPPORTED_LANGUAGES.flatMap((l) => l.aliases.map((a) => [a.toLowerCase(), l])));

/** Normalizes a language code OR a full BCP-47-ish locale ("te", "te-IN",
 * "te_IN") to a known language entry, or null if not recognized. */
function languageFromCodeOrLocale(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0];
  return BY_CODE.get(primary) || null;
}

/** Matches a free-text string (translation name, title, filename) against
 * known language names/aliases — "French Bible" matches "french", and
 * inflected forms ("française", "española", "Deutsche") also match their
 * base alias, since real-world metadata uses them. Requires a boundary
 * BEFORE the alias (so "Frenchtown" doesn't match "french" as a prefix of
 * something else) but allows trailing letters after it (so the inflected
 * suffix doesn't block the match) — and uses \p{L} (Unicode letter
 * category) rather than \b, since JS's \b only recognizes ASCII word
 * characters and would otherwise silently fail right next to letters like
 * ñ/ç/ü in aliases such as "español"/"français"/"deutsch". Returns every
 * match found (a string can plausibly name more than one language, e.g.
 * "English-French Bible"). */
function matchLanguageNames(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return [];
  const found = [];
  for (const [alias, lang] of BY_ALIAS) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}\\p{L}*`, "u");
    if (re.test(raw) && !found.includes(lang)) found.push(lang);
  }
  return found;
}

// ---------------------------------------------------------------------
// Unicode script detection
// ---------------------------------------------------------------------

// Well-established Unicode block ranges. Each of these blocks (other than
// Devanagari and Latin) is used by exactly one language in
// SUPPORTED_LANGUAGES, so a strong presence of one of them is strong
// evidence for that specific language, not just "some Indic script".
const SCRIPT_RANGES = {
  telugu: /[\u0C00-\u0C7F]/g,
  tamil: /[\u0B80-\u0BFF]/g,
  kannada: /[\u0C80-\u0CFF]/g,
  malayalam: /[\u0D00-\u0D7F]/g,
  bengali: /[\u0980-\u09FF]/g,
  gujarati: /[\u0A80-\u0AFF]/g,
  gurmukhi: /[\u0A00-\u0A7F]/g,
  devanagari: /[\u0900-\u097F]/g,
  // Deliberately narrow (letters only, not all Latin-1 punctuation/symbols)
  // so ordinary ASCII text with a stray accented character isn't
  // over-counted, while still covering French/Spanish/Portuguese/German
  // diacritics (é, ñ, ã, ü, ...).
  latin: /[A-Za-z\u00C0-\u017F]/g,
};

/** Counts how much of `text` falls into each script bucket, as a fraction
 * of all "letter-like" characters counted (not of the whole string, which
 * would be diluted by spaces/punctuation/digits/verse numbers). */
function scriptProfile(text) {
  const sample = String(text || "").slice(0, 5000); // plenty for a stable signal; avoids scanning a whole huge translation
  const counts = {};
  let total = 0;
  for (const [script, re] of Object.entries(SCRIPT_RANGES)) {
    const matches = sample.match(re);
    const n = matches ? matches.length : 0;
    counts[script] = n;
    if (script !== "latin") total += n; // count each non-Latin block once
  }
  // Latin overlaps with nothing else here (none of the Indic ranges
  // include Latin codepoints), so it's safe to add directly.
  total += counts.latin;
  return { counts, total };
}

/**
 * Script evidence -> candidate language(s) with confidence.
 *   - A unique-script language (Telugu, Tamil, ...) with a solid
 *     majority of the sample in its script: high confidence, ONE
 *     candidate, source "unicode-script".
 *   - A shared-script family (Devanagari, Latin) present: lower
 *     confidence, MULTIPLE candidates (every language sharing that
 *     script) — genuinely ambiguous on script alone, exactly per PART 7's
 *     "do NOT assume Devanagari = Hindi" requirement.
 *   - No clear majority script: no evidence.
 */
function scoreUnicodeScript(sampleText) {
  const { counts, total } = scriptProfile(sampleText);
  if (total < 20) return null; // too little text to say anything reliable

  const uniqueScriptLangs = SUPPORTED_LANGUAGES.filter((l) => l.script);
  for (const lang of uniqueScriptLangs) {
    const n = counts[lang.script] || 0;
    if (n / total >= 0.6) {
      return { language: lang, confidence: 0.9, source: "unicode-script", candidates: [lang] };
    }
  }
  for (const shared of ["devanagari", "latin"]) {
    const n = counts[shared] || 0;
    if (n / total >= 0.6) {
      const candidates = SUPPORTED_LANGUAGES.filter((l) => l.sharedScript === shared);
      // A shared script alone can't pick one language — real ambiguity,
      // not false precision. See scoreVocabulary for a same-script
      // tie-breaker.
      return { language: null, confidence: 0.35, source: "unicode-script", candidates, sharedScript: shared };
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Lightweight vocabulary tie-breaker for languages that share a script.
//
// These word lists are common function words, not a linguistic corpus —
// they exist ONLY to break ties within an already-narrowed script family
// (e.g. "is this Devanagari text Hindi, Marathi, or Nepali?"), never to
// identify a language on their own. Treat this as a modest heuristic:
// good enough to prefer the right candidate when real distinguishing
// words are present in a multi-verse sample, not a guarantee.
// ---------------------------------------------------------------------

const VOCABULARY = {
  hi: ["है", "और", "के", "में", "की", "को", "का", "से", "यह", "हैं"],
  mr: ["आहे", "आणि", "च्या", "मध्ये", "त्याने", "ती", "नाही", "होते", "याचा", "आपल्या"],
  ne: ["छ", "गर्नुहोस्", "थियो", "लाई", "मा", "यो", "हुन्", "गरे", "थिए", "आफ्नो"],
  en: ["the", "and", "of", "to", "that", "was", "he", "for", "his", "unto"],
  fr: ["le", "la", "les", "et", "des", "une", "est", "dans", "que", "qui"],
  es: ["el", "la", "los", "las", "que", "en", "un", "es", "por", "para"],
  pt: ["que", "não", "uma", "os", "para", "com", "seu", "sua", "foi", "está"],
  de: ["der", "die", "und", "nicht", "das", "ist", "den", "mit", "sich", "sie"],
  it: ["il", "che", "di", "non", "per", "con", "sono", "una", "gli", "loro"],
};

function scoreVocabulary(sampleText, candidates) {
  const sample = String(sampleText || "").toLowerCase().slice(0, 20000);
  if (!sample || !candidates?.length) return null;

  let best = null;
  for (const lang of candidates) {
    const words = VOCABULARY[lang.code];
    if (!words) continue;
    let hits = 0;
    let distinct = 0;
    for (const w of words) {
      const re = new RegExp(`(?:^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^\\p{L}]|$)`, "gu");
      const m = sample.match(re);
      if (m?.length) { hits += m.length; distinct++; }
    }
    // Require several distinct function words to actually show up —
    // one incidental match is noise, not evidence.
    if (distinct >= 3 && (!best || hits > best.hits)) best = { lang, hits, distinct };
  }
  if (!best) return null;
  // Confidence scales gently with how many distinct words matched;
  // capped well below "explicit metadata" territory since this is a
  // heuristic, not a declaration.
  const confidence = Math.min(0.55 + best.distinct * 0.03, 0.75);
  return { language: best.lang, confidence, source: "vocabulary", candidates: [best.lang] };
}

// ---------------------------------------------------------------------
// Filename detection
// ---------------------------------------------------------------------

const FILENAME_NOISE = /\b(bible|translation|version|json|xml|the|holy|scripture)\b/gi;

function scoreFilename(filename) {
  if (!filename) return null;
  const base = String(filename).replace(/\.(json|xml)$/i, "");
  const cleaned = base.replace(/[_\-]+/g, " ").replace(FILENAME_NOISE, " ").trim();
  if (!cleaned) return null;
  const matches = matchLanguageNames(cleaned);
  if (!matches.length) return null;
  // Filename evidence is real but deliberately modest (PART 6: must not
  // override stronger metadata/text evidence) — see combine() below,
  // which only ever lets filename evidence corroborate, never overrule.
  return { language: matches[0], confidence: 0.55, source: "filename", candidates: matches };
}

// ---------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------

/** Combines independent pieces of evidence for the SAME language via
 * 1 - Π(1 - cᵢ) (treats sources as independent corroborating signals) —
 * a filename agreeing with a script match raises confidence above either
 * alone, without letting either source individually claim more certainty
 * than it has. Capped at 0.97 (only an explicit field ever reaches 0.99+). */
function combineConfidences(confidences) {
  const combined = 1 - confidences.reduce((acc, c) => acc * (1 - c), 1);
  return Math.min(combined, 0.97);
}

function normalizeSample(verses) {
  if (!verses || typeof verses !== "object") return "";
  const parts = [];
  outer:
  for (const book of Object.values(verses)) {
    if (!book || typeof book !== "object") continue;
    for (const chapter of Object.values(book)) {
      if (!chapter || typeof chapter !== "object") continue;
      for (const text of Object.values(chapter)) {
        if (typeof text === "string") parts.push(text);
        if (parts.join(" ").length > 8000) break outer; // plenty for script/vocabulary analysis
      }
    }
  }
  return parts.join(" ");
}

/**
 * Runs the full evidence pipeline. `input`:
 *   explicitLanguage — raw `language`/`translation.language`/`metadata.language` field, if any
 *   explicitCode     — raw `lang`/`languageCode`/`metadata.lang` field, if any
 *   explicitLocale   — raw `locale`/`metadata.locale` field, if any (e.g. "te-IN")
 *   translationName, title, description — free-text metadata fields
 *   filename         — the imported file's name
 *   verses           — the parsed { bookKey: { chapter: { verse: text } } } map, for script/vocabulary analysis
 */
export function detectLanguage({
  explicitLanguage,
  explicitCode,
  explicitLocale,
  translationName,
  title,
  description,
  filename,
  verses,
} = {}) {
  // --- Priority 1: explicit metadata --------------------------------
  const explicitName = String(explicitLanguage || "").trim();
  if (explicitName) {
    const known = BY_NAME.get(explicitName.toLowerCase()) || BY_ALIAS.get(explicitName.toLowerCase());
    return {
      language: known ? known.name : explicitName,
      languageCode: known ? known.code : null,
      confidence: 0.99,
      source: "explicit-metadata",
      ambiguous: false,
      candidates: [],
    };
  }
  const fromCode = languageFromCodeOrLocale(explicitCode) || languageFromCodeOrLocale(explicitLocale);
  if (fromCode) {
    return { language: fromCode.name, languageCode: fromCode.code, confidence: 0.97, source: "language-code", ambiguous: false, candidates: [] };
  }

  // --- Gather weaker, combinable evidence ----------------------------
  const sampleText = normalizeSample(verses);
  const metadataMatches = matchLanguageNames([translationName, title, description].filter(Boolean).join(" "));
  const metadataEvidence = metadataMatches.length
    ? { language: metadataMatches[0], confidence: 0.75, source: "translation-metadata", candidates: metadataMatches }
    : null;
  const filenameEvidence = scoreFilename(filename);
  const scriptEvidence = scoreUnicodeScript(sampleText);
  const vocabEvidence = scriptEvidence && !scriptEvidence.language
    ? scoreVocabulary(sampleText, scriptEvidence.candidates)
    : null;

  const signals = [metadataEvidence, filenameEvidence, scriptEvidence?.language ? scriptEvidence : null, vocabEvidence].filter(Boolean);

  if (!signals.length) {
    // Script was ambiguous (shared family) and nothing else narrowed it —
    // still surface the narrowed candidate list rather than the entire
    // supported-language list, so the manual picker is at least sorted
    // sensibly, even though nothing here is confident.
    return {
      language: null,
      languageCode: null,
      confidence: 0,
      source: scriptEvidence ? "unicode-script" : "none",
      ambiguous: true,
      candidates: scriptEvidence?.candidates || SUPPORTED_LANGUAGES,
    };
  }

  // Pick the language with the strongest single piece of support, then
  // fold in any other signal that agrees with it. A weaker signal for a
  // DIFFERENT language never overrides a stronger signal that disagrees —
  // it simply doesn't contribute (see PART 6/7: filename/shared-script
  // evidence must not outrank stronger, more specific evidence).
  const bySingleStrength = [...signals].sort((a, b) => b.confidence - a.confidence);
  const winner = bySingleStrength[0].language;
  const agreeing = signals.filter((s) => s.language === winner).map((s) => s.confidence);
  const confidence = agreeing.length > 1 ? combineConfidences(agreeing) : agreeing[0];
  const sourceNames = [...new Set(signals.filter((s) => s.language === winner).map((s) => s.source))];

  const ambiguous = confidence < CONFIDENCE_THRESHOLD;
  return {
    language: ambiguous ? null : winner.name,
    languageCode: ambiguous ? null : winner.code,
    confidence,
    source: sourceNames.length > 1 ? "combined" : sourceNames[0],
    ambiguous,
    // When ambiguous, offer the winner plus whatever the script narrowed
    // things down to (e.g. "leaning French, but here's the whole Latin
    // family") rather than either just one guess or the full language list.
    candidates: ambiguous
      ? [...new Set([winner, ...(scriptEvidence?.candidates || [])])]
      : [],
  };
}
