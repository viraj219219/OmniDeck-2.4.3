// Minimal structural checker for PowerShell source, used when pwsh is unavailable
// (the real parser test is skipped there, which let an orphaned `finally` ship).
// Strips comments, strings and here-strings, then verifies braces/parens/brackets
// balance and that every `catch`/`finally` directly follows the `}` of a try/catch.
export function checkPowerShellStructure(src) {
  const text = src.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (c === "<" && c2 === "#") { const e = text.indexOf("#>", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "#") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "@" && (c2 === '"' || c2 === "'") && /^[ \t]*\n/.test(text.slice(i + 2))) {
      const close = new RegExp(`\\n${c2}@`);
      const m = close.exec(text.slice(i + 2));
      if (!m) return ["unterminated here-string"];
      i = i + 2 + m.index + 3; out.push(" "); continue;
    }
    if (c === "`") { i += 2; continue; }
    if (c === "'") { i++; while (i < n && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1; i++; out.push(" "); continue; }
    if (c === '"') { i++; while (i < n && text[i] !== '"') i += text[i] === "`" ? 2 : 1; i++; out.push(" "); continue; }
    out.push(c); i++;
  }
  const code = out.join("");
  const problems = [];
  const stack = [];                       // {ch, kw}
  const re = /[{}()\[\]]|\b(try|catch|finally|else|elseif)\b/gi;
  let m, pendingKw = null, lastClosed = null, lastEnd = -1;
  while ((m = re.exec(code))) {
    const t = m[0].toLowerCase();
    const line = code.slice(0, m.index).split("\n").length;
    if (t === "try" || t === "catch" || t === "finally") {
      const between = lastEnd >= 0 ? code.slice(lastEnd, m.index) : "x";
      if (t !== "try") {
        if (!(lastClosed && /^\s*$/.test(between) && (lastClosed === "try" || lastClosed === "catch")))
          problems.push(`line ${line}: '${t}' is not attached to a preceding try/catch block`);
      }
      pendingKw = t; continue;
    }
    if (t === "else" || t === "elseif") { pendingKw = t; continue; }
    if ("{([".includes(t)) { stack.push({ ch: t, kw: t === "{" ? pendingKw : null, line }); pendingKw = null; continue; }
    const open = stack.pop();
    const want = { "}": "{", ")": "(", "]": "[" }[t];
    if (!open || open.ch !== want) { problems.push(`line ${line}: unexpected '${t}'`); break; }
    if (t === "}") { lastClosed = open.kw; lastEnd = m.index + 1; }
  }
  for (const o of stack) problems.push(`line ${o.line}: '${o.ch}' is never closed`);
  return problems;
}
