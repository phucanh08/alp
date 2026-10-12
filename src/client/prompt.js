import { emitKeypressEvents } from 'node:readline';

const dim = text => `\x1b[2m${text}\x1b[22m`;
const cyan = text => `\x1b[36m${text}\x1b[39m`;

export class Cancelled extends Error {
  constructor() { super('Setup cancelled.'); }
}

/**
 * A select box in the terminal: ↑/↓ (or k/j) move, Enter picks, Ctrl-C or Esc cancels.
 * Choices are { label, value, hint? }; `initial` is the value highlighted first.
 * @template T
 * @param {{ message: string, choices: Array<{ label: string, value: T, hint?: string }>, initial?: T }} question
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [io]
 * @returns {Promise<T>}
 */
export function select({ message, choices, initial }, { input = process.stdin, output = process.stdout } = {}) {
  let index = Math.max(0, choices.findIndex(choice => choice.value === initial));
  let drawn = 0;
  const draw = () => {
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = [`${cyan('?')} ${message} ${dim('(↑/↓, Enter)')}`, ...choices.map((choice, at) =>
      at === index ? cyan(`❯ ${choice.label}`) + (choice.hint ? ` ${dim(choice.hint)}` : '') : `  ${choice.label}${choice.hint ? ` ${dim(choice.hint)}` : ''}`)];
    output.write(lines.join('\n') + '\n');
    drawn = lines.length;
  };
  return new Promise((resolve, reject) => {
    emitKeypressEvents(input);
    const raw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    output.write('\x1b[?25l');
    const done = (settle, value) => {
      input.off('keypress', onKey);
      input.setRawMode?.(raw ?? false);
      input.pause();
      output.write(`\x1b[${drawn}A\x1b[0J\x1b[?25h`);
      if (settle === resolve) output.write(`${cyan('✔')} ${message} ${cyan(choices[index].label)}\n`);
      settle(value);
    };
    const onKey = (text, key = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return done(reject, new Cancelled());
      if (key.name === 'return' || key.name === 'enter') return done(resolve, choices[index].value);
      if (key.name === 'up' || key.name === 'k') index = (index + choices.length - 1) % choices.length;
      else if (key.name === 'down' || key.name === 'j') index = (index + 1) % choices.length;
      else return;
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}

/**
 * A line of text, for a value the list does not offer.
 * @param {string} message
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [io]
 */
export async function text(message, { input = process.stdin, output = process.stdout } = {}) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  try { return (await rl.question(`${cyan('?')} ${message} `)).trim(); } finally { rl.close(); }
}
