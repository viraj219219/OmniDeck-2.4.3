// Real functional smoke tests for QuizService grading/validation across all
// four question types. No mocks — exercises the actual StorageQuizService.
import { quizService, normalizeAnswerText } from "../src/js/services/QuizService.js";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS — ${name}`);
  else { failures++; console.error(`FAIL — ${name}`); }
}

// --- Multiple choice ---
const mc = { questionType: "multiple_choice", question: "Who defeated Goliath?", options: ["Saul", "David", "Jonathan", "Samuel"], correctIndex: 1 };
check("MC: correct index graded correct", quizService.checkAnswer(mc, 1) === true);
check("MC: wrong index graded incorrect", quizService.checkAnswer(mc, 0) === false);
check("MC: valid page has no validation problems", quizService.validateQuizPage(mc).length === 0);
check("MC: missing correctIndex is flagged", quizService.validateQuizPage({ ...mc, correctIndex: null }).length > 0);

// --- True/False ---
const tf = { questionType: "true_false", question: "David used a sling.", options: ["True", "False"], correctIndex: 0 };
check("T/F: correct graded correct", quizService.checkAnswer(tf, 0) === true);
check("T/F: incorrect graded incorrect", quizService.checkAnswer(tf, 1) === false);

// --- Fill in the blank ---
const fb = { questionType: "fill_blank", question: "David defeated ___ with a sling.", acceptedAnswers: ["Goliath", "the giant"] };
check("Fill-blank: exact match", quizService.checkAnswer(fb, "Goliath") === true);
check("Fill-blank: case-insensitive match", quizService.checkAnswer(fb, "goliath") === true);
check("Fill-blank: whitespace/punctuation tolerant", quizService.checkAnswer(fb, "  Goliath. ") === true);
check("Fill-blank: alternate accepted answer matches", quizService.checkAnswer(fb, "the giant") === true);
check("Fill-blank: wrong answer graded incorrect", quizService.checkAnswer(fb, "Saul") === false);
check("Fill-blank: empty answer graded incorrect", quizService.checkAnswer(fb, "") === false);
check("Fill-blank: missing accepted answers is flagged", quizService.validateQuizPage({ ...fb, acceptedAnswers: [] }).length > 0);

// --- Short answer ---
const sa = { questionType: "short_answer", question: "What did David use to defeat Goliath?", acceptedAnswers: ["a sling", "sling and stone", "a sling and a stone"] };
check("Short answer: accepted phrasing matches", quizService.checkAnswer(sa, "a sling") === true);
check("Short answer: extra spaces/case tolerant", quizService.checkAnswer(sa, "  A SLING  ") === true);
check("Short answer: unrelated text graded incorrect", quizService.checkAnswer(sa, "a sword") === false);

// --- normalizeAnswerText ---
check("normalize: collapses internal whitespace", normalizeAnswerText("king   david") === "king david");
check("normalize: strips trailing punctuation", normalizeAnswerText("David.") === "david");
check("normalize: strips surrounding quotes", normalizeAnswerText('"David"') === "david");

// --- Legacy pages (no questionType set) grade as multiple_choice ---
const legacy = { question: "Legacy quiz page", options: ["A", "B"], correctIndex: 0 };
check("Legacy page (no questionType) still grades by index", quizService.checkAnswer(legacy, 0) === true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
