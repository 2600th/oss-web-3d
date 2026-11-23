/**
 * Guard against backticks inside GLSL.
 *
 * Every shader in this project lives in a JavaScript template literal. A
 * backtick written inside one -- almost always in a comment, quoting an
 * expression the way you would in prose -- silently terminates the literal.
 * What follows is then parsed as JavaScript, and because GLSL and JS share
 * enough syntax the file usually still *parses*: the failure surfaces much
 * later as a bare "ReferenceError: rough is not defined" at runtime, with
 * nothing pointing at the shader that caused it.
 *
 * This has cost two debugging cycles, so it is checked mechanically now.
 *
 * The check tracks template-literal state properly rather than scanning for
 * backticks in comments generally, because ordinary JSDoc outside a literal is
 * free to quote code and does so in several files here. Only a comment *inside*
 * a template literal is a problem.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

/**
 * Report comment spans inside template literals that contain a backtick.
 * `stack` holds one frame per nesting level: a template literal, or a ${}
 * expression within one.
 */
function scan(source) {
  const found = [];
  const stack = [];
  let line = 1;
  let i = 0;

  const inTemplate = () => stack.length > 0 && stack[stack.length - 1].kind === 'template';

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') {
      line++;
      i++;
      continue;
    }

    // Comment spans. Inside a template these are GLSL comments, and a backtick
    // within one is the bug being hunted; outside, they are ordinary JS.
    if (c === '/' && (next === '/' || next === '*')) {
      const end =
        next === '/'
          ? (source.indexOf('\n', i) + 1 || source.length)
          : (source.indexOf('*/', i) + 2 || source.length);
      const span = source.slice(i, end);
      if (inTemplate() && span.includes('`')) {
        found.push({ line, text: span.split('\n')[0].trim().slice(0, 68) });
      }
      line += (span.match(/\n/g) || []).length;
      i = end;
      continue;
    }

    if (c === '\\') {
      i += 2;
      continue;
    }

    if (inTemplate()) {
      if (c === '`') {
        stack.pop();
        i++;
      } else if (c === '$' && next === '{') {
        stack.push({ kind: 'expr', braces: 0 });
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Ordinary JavaScript context.
    if (c === '`') {
      stack.push({ kind: 'template' });
      i++;
    } else if (c === "'" || c === '"') {
      const end = source.indexOf('\n', i);
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      i = j + 1;
      if (end !== -1 && i > end) line++;
    } else if (c === '{' && stack.length) {
      stack[stack.length - 1].braces++;
      i++;
    } else if (c === '}' && stack.length) {
      const top = stack[stack.length - 1];
      if (top.kind === 'expr' && top.braces === 0) stack.pop();
      else top.braces--;
      i++;
    } else {
      i++;
    }
  }
  return found;
}

/**
 * Reversed-edge smoothstep.
 *
 * GLSL specifies smoothstep as undefined when edge0 >= edge1. Writing
 * smoothstep(1.0, 0.9, x) to mean "fade out" happens to work on desktop
 * drivers, which evaluate the same clamped ratio with a negative denominator,
 * so it survives every test until it reaches a driver that does not -- and
 * mobile GPUs are exactly where that shows up, as a shader that compiles and
 * renders garbage. Write 1.0 - smoothstep(low, high, x) instead.
 */
function reversedSmoothstep(source) {
  const found = [];
  const re = /smoothstep\(\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*,/g;
  source.split(/\r?\n/).forEach((line, i) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      if (parseFloat(m[1]) >= parseFloat(m[2])) {
        found.push({ line: i + 1, text: `smoothstep(${m[1]}, ${m[2]}, ...)` });
      }
    }
  });
  return found;
}

const problems = [];
for await (const file of walk(ROOT)) {
  const source = await readFile(file, 'utf8');
  for (const hit of scan(source)) {
    problems.push(`${relative(ROOT, file)}:${hit.line}  backtick in shader comment -- ${hit.text}`);
  }
  for (const hit of reversedSmoothstep(source)) {
    problems.push(
      `${relative(ROOT, file)}:${hit.line}  reversed-edge smoothstep (undefined in GLSL) -- ${hit.text}`,
    );
  }
}

if (problems.length) {
  console.error('GLSL template literal check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`GLSL template literal check passed.`);
