/**
 * QuizService — quiz validation/grading, kept separate from LessonService
 * because grading logic (and eventually class-level score tracking) is a
 * distinct concern from lesson page storage.
 *
 * Supports four question types, stored on the quiz page as `page.type`:
 *   - "multiple_choice" (default, incl. legacy pages with no `type` set)
 *   - "true_false"
 *   - "fill_blank"
 *   - "short_answer"
 *
 * multiple_choice/true_false are graded by index (`page.options` +
 * `page.correctIndex`) — unchanged from before. fill_blank/short_answer are
 * graded by real text comparison against `page.acceptedAnswers` (one or
 * more accepted correct answers), never by an AI call at grading time —
 * grading must work fully offline and instantly.
 */
export class QuizService {
  /** @returns {boolean} whether `answer` is correct for `quizPage`.
   * `answer` is an option index (number) for multiple_choice/true_false,
   * or the teacher-entered text (string) for fill_blank/short_answer. */
  checkAnswer(_quizPage, _answer) { throw new Error("Not implemented"); }
  validateQuizPage(_quizPage) { throw new Error("Not implemented"); }
}

const TEXT_TYPES = new Set(["fill_blank", "short_answer"]);

/** Normalizes text for grading: lowercase, trim, collapse internal
 * whitespace, strip common leading/trailing punctuation. Intentionally
 * simple and deterministic (no AI call, no fuzzy matching) so grading is
 * instant and works fully offline. */
export function normalizeAnswerText(text) {
  return String(text ?? "")
    .toLowerCase()
    .trim()
    .replace(/^[\s"'.,!?;:]+|[\s"'.,!?;:]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * StorageQuizService — real grading/validation logic (not a stub). Named
 * for parity with the other services even though it currently holds no
 * persisted state of its own; grading always defers to the actual answer
 * data stored on the lesson page, never a value baked into the
 * presentation UI.
 */
export class StorageQuizService extends QuizService {
  checkAnswer(quizPage, answer) {
    if (TEXT_TYPES.has(quizPage?.questionType)) {
      const normalized = normalizeAnswerText(answer);
      if (!normalized) return false;
      return (quizPage.acceptedAnswers || []).some((a) => normalizeAnswerText(a) === normalized);
    }
    return quizPage?.correctIndex === answer;
  }

  /** Returns a list of human-readable problems, empty array if the quiz page is well-formed. */
  validateQuizPage(quizPage) {
    const problems = [];
    if (!quizPage?.question?.trim()) problems.push("Add a question.");

    if (TEXT_TYPES.has(quizPage?.questionType)) {
      const filled = (quizPage?.acceptedAnswers || []).map((a) => a.trim()).filter(Boolean);
      if (filled.length < 1) problems.push("Add at least one accepted answer.");
      return problems;
    }

    const filled = (quizPage?.options || []).filter((o) => o.trim());
    if (filled.length < 2) problems.push("Add at least two answer options.");
    if (quizPage?.correctIndex == null || !quizPage.options[quizPage.correctIndex]?.trim()) {
      problems.push("Mark which option is correct.");
    }
    return problems;
  }
}

// Singleton used throughout the app.
export const quizService = new StorageQuizService();
