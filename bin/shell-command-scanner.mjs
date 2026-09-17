const HEREDOC_RE = /^<<(?!<)(-?)[ \t]*(?:(['"])(.*?)\2|([^\s;&|()<>]+))/;

function heredocDescriptor(source, start) {
  const match = source.slice(start).match(HEREDOC_RE);
  if (!match) return undefined;

  return {
    delimiter: match[3] ?? match[4],
    end: start + match[0].length,
    stripTabs: match[1] === '-',
  };
}
function spaces(length) {
  return ' '.repeat(length);
}

/**
 * Keep only text that the shell can interpret as executable syntax.
 * Quoted text and heredoc bodies are masked while separators and newlines
 * outside them are retained for command-boundary checks.
 *
 * @param {string} command
 * @returns {string}
 */
export function shellExecutableText(command) {
  const source = String(command ?? '');
  const output = [];
  const heredocs = [];
  let activeHeredoc;
  let quote;
  let index = 0;

  while (index < source.length) {
    if (activeHeredoc) {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd === -1 ? source.length : lineEnd;
      const line = source.slice(index, end);
      const candidate = activeHeredoc.stripTabs ? line.replace(/^\t+/, '') : line;

      if (candidate === activeHeredoc.delimiter) {
        activeHeredoc = heredocs.shift();
        output.push(spaces(line.length));
        if (lineEnd !== -1) output.push('\n');
      } else {
        output.push(spaces(line.length));
      }

      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }

    const character = source[index];

    if (quote) {
      if (quote === '"' && character === '\\') {
        output.push(spaces(Math.min(2, source.length - index)));
        index += Math.min(2, source.length - index);
        continue;
      }
      if (character === quote) quote = undefined;
      output.push(' ');
      index += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      output.push(' ');
      index += 1;
      continue;
    }

    if (character === '\\') {
      output.push(spaces(Math.min(2, source.length - index)));
      index += Math.min(2, source.length - index);
      continue;
    }

    if (character === '<' && source[index + 1] === '<') {
      const heredoc = heredocDescriptor(source, index);
      if (heredoc) {
        output.push(spaces(heredoc.end - index));
        heredocs.push(heredoc);
        index = heredoc.end;
        continue;
      }
    }

    output.push(character);
    index += 1;

    if (character === '\n' && heredocs.length > 0) {
      activeHeredoc = heredocs.shift();
    }
  }

  return output.join('');
}
