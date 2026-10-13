import { detectLanguage, SUPPORTED_LANGUAGES, CONFIDENCE_THRESHOLD } from "../src/js/services/BibleLanguageDetectionService.js";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS — ${name}`);
  else { failures++; console.error(`FAIL — ${name}`); }
}

// Real Unicode script samples (short, illustrative test fixtures — NOT
// verified against any specific published translation; they exist only to
// give the script-detection algorithm real characters from each block).
const SCRIPT_SAMPLE = {
  telugu: "ఆదియందు దేవుడు భూమ్యాకాశములను సృజించెను. భూమి నిరాకారముగాను శూన్యముగాను ఉండెను. దేవుడు వెలుగు కమ్మని పలుకగా వెలుగు కలిగెను.",
  tamil: "ஆதியிலே தேவன் வானத்தையும் பூமியையும் சிருஷ்டித்தார். பூமியானது ஒழுங்கின்மையும் வெறுமையுமாய் இருந்தது.",
  kannada: "ಆದಿಯಲ್ಲಿ ದೇವರು ಆಕಾಶವನ್ನೂ ಭೂಮಿಯನ್ನೂ ಸೃಷ್ಟಿಸಿದನು. ಭೂಮಿಯು ಅಸ್ತವ್ಯಸ್ತವಾಗಿಯೂ ಶೂನ್ಯವಾಗಿಯೂ ಇತ್ತು.",
  malayalam: "ആദിയിൽ ദൈവം ആകാശവും ഭൂമിയും സൃഷ്ടിച്ചു. ഭൂമി പാഴായും ശൂന്യമായും ഇരുന്നു.",
  bengali: "আদিতে ঈশ্বর আকাশমণ্ডল ও পৃথিবীর সৃষ্টি করিলেন। পৃথিবী বিরাণ ও শূন্য ছিল।",
  gujarati: "આરંભે દેવે આકાશ તથા પૃથ્વીનું સર્જન કર્યું. પૃથ્વી અસ્તવ્યસ્ત તથા ખાલી હતી.",
  gurmukhi: "ਆਦ ਵਿੱਚ ਪਰਮੇਸ਼ੁਰ ਨੇ ਅਕਾਸ਼ ਤੇ ਧਰਤੀ ਨੂੰ ਉਤਪਤ ਕੀਤਾ। ਧਰਤੀ ਬੇਡੌਲ ਤੇ ਸੁੰਨੀ ਸੀ।",
  // Devanagari — deliberately no distinguishing vocabulary added beyond
  // what's needed to test the shared-script-only (ambiguous) path.
  devanagariGeneric: "आदि में परमेश्वर ने आकाश और पृथ्वी की सृष्टि की। पृथ्वी बेडौल और सुनसान थी।",
  hindiVocab: "आरम्भ में परमेश्वर ने आकाश और पृथ्वी की सृष्टि की, और यह सब कुछ उसके द्वारा और उसके लिये है और वह सबसे बड़ा है।",
  marathiVocab: "देवाने आरंभी आकाश आणि पृथ्वी निर्माण केली, आणि पृथ्वीच्या मध्ये अंधार होते आणि ती काहीच नव्हती.",
};

const enText = "In the beginning God created the heavens and the earth, and the earth was formless, and the Spirit of God was hovering.";
const frText = "Au commencement, Dieu créa les cieux et la terre. Or, la terre était informe et vide, et il y avait des ténèbres.";
const esText = "En el principio creó Dios los cielos y la tierra. Y la tierra estaba desordenada y vacía, y era de noche.";

function versesOf(text) {
  return { genesis: { "1": { "1": text, "2": text } } };
}

// --- 1-3: Telugu, no explicit language field -----------------------------
let r = detectLanguage({ filename: "Telugu Bible.json", verses: versesOf(SCRIPT_SAMPLE.telugu) });
check("1. Telugu Bible.json + Telugu script, no explicit field -> Telugu, high confidence", r.language === "Telugu" && r.languageCode === "te" && !r.ambiguous);

r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.telugu) });
check("2. Telugu Unicode text alone (no filename, no metadata) -> Telugu via unicode-script", r.language === "Telugu" && r.languageCode === "te" && r.source === "unicode-script");

r = detectLanguage({ filename: "telugu_bible.json", verses: versesOf(SCRIPT_SAMPLE.telugu) });
check("3. Unusual filename formatting (telugu_bible.json) still recognized", r.language === "Telugu");

// --- 4-7: other unique-script Indic languages -----------------------------
r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.tamil) });
check("4. Tamil script detected generically (same pipeline, no Tamil-specific code)", r.language === "Tamil" && r.languageCode === "ta");

r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.kannada) });
check("5. Kannada script detected", r.language === "Kannada" && r.languageCode === "kn");

r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.malayalam) });
check("6. Malayalam script detected", r.language === "Malayalam" && r.languageCode === "ml");

r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.bengali) });
check("7. Bengali script detected", r.language === "Bengali" && r.languageCode === "bn");

// --- 8: English -------------------------------------------------------
r = detectLanguage({ verses: versesOf(enText), filename: "English Bible.json" });
check("8. English (Latin script + filename agreement)", r.language === "English" && r.languageCode === "en");

// --- 9-11: French, Spanish, Portuguese --------------------------------
r = detectLanguage({ translationName: "Bible en Français", verses: versesOf(frText) });
check("9. French detected via translation-name + Latin/vocab evidence", r.language === "French" && r.languageCode === "fr" && !r.ambiguous);

r = detectLanguage({ translationName: "Biblia Española", verses: versesOf(esText) });
check("10. Spanish detected via translation-name text", r.language === "Spanish" && r.languageCode === "es" && !r.ambiguous);

r = detectLanguage({ explicitLanguage: "Portuguese", verses: versesOf("texto qualquer") });
check("11. Portuguese via explicit metadata", r.language === "Portuguese" && r.languageCode === "pt" && r.source === "explicit-metadata");

// --- 12: German ---------------------------------------------------------
r = detectLanguage({ explicitLanguage: "German" });
check("12. German via explicit metadata (no verse text needed at all)", r.language === "German" && r.languageCode === "de");

// --- 13: explicit language metadata field -------------------------------
r = detectLanguage({ explicitLanguage: "Telugu" });
check("13. Explicit language field -> immediate high confidence, source explicit-metadata", r.language === "Telugu" && r.confidence >= 0.99 && r.source === "explicit-metadata");

// --- 14: language code -------------------------------------------------
r = detectLanguage({ explicitCode: "te" });
check("14. Language code 'te' -> Telugu", r.language === "Telugu" && r.languageCode === "te" && r.source === "language-code");

// --- 15: locale -----------------------------------------------------------
r = detectLanguage({ explicitLocale: "te-IN" });
check("15. Locale 'te-IN' normalizes to Telugu", r.language === "Telugu" && r.languageCode === "te");
r = detectLanguage({ explicitLocale: "hi_IN" });
check("15b. Underscore-style locale 'hi_IN' also normalizes", r.language === "Hindi" && r.languageCode === "hi");

// --- 16: ambiguous Devanagari-language Bible ------------------------------
r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.devanagariGeneric) });
check("16. Devanagari script ALONE is ambiguous (NOT auto-assumed Hindi)", r.ambiguous === true && r.language === null);
check("16b. Ambiguous Devanagari candidates include Hindi, Marathi, and Nepali", ["Hindi", "Marathi", "Nepali"].every((n) => r.candidates.some((c) => c.name === n)));

// vocabulary tie-breaker within the Devanagari family
r = detectLanguage({ verses: versesOf(SCRIPT_SAMPLE.hindiVocab) });
check("16c. Distinctive Hindi function words break the Devanagari tie", r.language === "Hindi" && !r.ambiguous);

// --- 17: ambiguous Latin-language Bible -----------------------------------
r = detectLanguage({ verses: versesOf("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor") });
check("17. Latin script alone, no recognizable vocabulary of any supported language -> ambiguous", r.ambiguous === true && r.language === null);
check("17b. Ambiguous Latin candidates include all six Latin-script languages", ["English", "French", "Spanish", "Portuguese", "German", "Italian"].every((n) => r.candidates.some((c) => c.name === n)));

// --- 18: unusual filename formatting --------------------------------------
r = detectLanguage({ filename: "Bible - Telugu.json", verses: versesOf(SCRIPT_SAMPLE.telugu) });
check("18. 'Bible - Telugu.json' (spaced hyphen) filename still parsed", r.language === "Telugu");
r = detectLanguage({ filename: "TELUGU-BIBLE.json" });
check("18b. All-caps filename with no verse text still gives filename evidence (ambiguous-level, not silently ignored)", r.candidates.some((c) => c.name === "Telugu") || r.language === "Telugu");

// --- 19: Unicode-heavy Bible (diacritics in a Latin translation-name) ----
r = detectLanguage({ translationName: "Français — Bible Louis Segond", verses: versesOf(frText) });
check("19. Unicode punctuation (em dash) in metadata doesn't break detection", r.language === "French");

// --- 20: filename must NOT override stronger metadata evidence -----------
r = detectLanguage({ translationName: "Deutsche Bibel", filename: "French Bible.json", verses: versesOf("Und Gott sprach: Es werde Licht, und es ward Licht, und Gott sah, dass es gut war.") });
check("20. Conflicting filename (French) does not override stronger translation-name+script evidence (German)", r.language === "German");

// --- combined evidence sanity ---------------------------------------------
r = detectLanguage({ filename: "Telugu Bible.json", verses: versesOf(SCRIPT_SAMPLE.telugu) });
check("Filename + script agreement combine to confidence above single-source alone", r.confidence > 0.9);

// --- every supported language is reachable via explicit metadata ---------
let allReachable = true;
for (const lang of SUPPORTED_LANGUAGES) {
  const result = detectLanguage({ explicitLanguage: lang.name });
  if (result.language !== lang.name || result.languageCode !== lang.code) allReachable = false;
}
check("Every supported language is detectable via its own explicit name (language-agnostic table-driven design)", allReachable);

// --- no evidence at all ---------------------------------------------------
r = detectLanguage({});
check("No evidence at all -> ambiguous, never a false guess", r.ambiguous === true && r.language === null && r.confidence === 0);

check("CONFIDENCE_THRESHOLD is a real number between 0 and 1", typeof CONFIDENCE_THRESHOLD === "number" && CONFIDENCE_THRESHOLD > 0 && CONFIDENCE_THRESHOLD < 1);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
