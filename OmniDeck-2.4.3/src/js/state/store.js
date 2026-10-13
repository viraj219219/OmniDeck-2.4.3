// Tiny pub/sub store. No Redux/MobX — this app is small enough that a
// single mutable object with subscribers is easier to reason about and
// keeps the "no frameworks" architecture consistent.

const state = {
  route: "home",
  routeParams: {},
  // The lesson currently open in the editor (full object, not just id) —
  // kept in memory and persisted via LessonService on every mutation.
  activeLesson: null,
  activeSlideId: null,
  // Bible browser selection, shared between the Bible view and the
  // "Add Scripture" flow inside the Lesson Editor.
  bible: {
    language: "English",
    book: null,
    chapter: null,
    selectedVerses: [], // array of verse numbers
  },
  presenting: false,
};

const subscribers = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  notify();
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  for (const fn of subscribers) fn(state);
}
