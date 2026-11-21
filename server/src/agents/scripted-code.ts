// SAMPLE code for the scripted agent (scripted.ts): "/code" answers with blocks in several languages,
// so the code block buttons and the highlighting can be tried, and "/streamcode" streams a reply
// with a long code block in it a few characters at a time, so a block can be watched being coloured
// while it grows. Never used by tests or a real store.

/** SAMPLE: what "/code" answers: blocks for trying Copy and Run (harmless commands only) and colours. */
export const CODE_SAMPLE = [
  'A quick one:',
  '```bash\necho hello\n```',
  'One that takes a while, to try stopping it:',
  '```sh\nsleep 30\necho finished\n```',
  'A transcript (only the `$` lines run):',
  '```console\n$ pwd\n/somewhere\n$ ls | head -3\n```',
  'And code that is not a shell block:',
  '```ts\n/**\n * The answer, typed.\n */\nexport function answer(question: string): number {\n  const known = new Map<string, number>([["life", 42]]);\n  return known.get(question) ?? -1; // unknown\n}\nconst greeting = `hello ${answer("life")}`;\n```',
  'Python:',
  '```python\n@dataclass\nclass Point:\n    x: float = 0.0\n\n    def norm(self) -> float:\n        """Length from the origin."""\n        return math.hypot(self.x, 0)  # one axis\n```',
  'A config file:',
  '```yaml\nname: kestrel\nversion: 0.0.18\nfeatures:\n  - highlighting  # new\n  - diffs\nenabled: true\n```',
  'A diff:',
  '```diff\n--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n```',
  'And one Kestrel does not know, drawn plain:',
  '```brainfuck\n++++++[>++++++++<-]>.\n```',
].join('\n\n');

/** SAMPLE: the code "/streamcode" writes, repeated so the block grows long. */
const STREAMED_FUNCTION = [
  '/* Parse a line of the log.',
  '   Lines that do not parse are skipped. */',
  'function parseLine(line: string, index: number): Entry | null {',
  '  const match = /^(\\d+)\\s+(\\w+)\\s+(.*)$/.exec(line);',
  '  if (!match) return null;',
  '  return { at: Number(match[1]), level: match[2] as Level, text: `${index}: ${match[3]}` };',
  '}',
  '',
].join('\n');

/** How many times the function is written into the streamed block. */
const STREAMED_REPEATS = 12;

/** SAMPLE: the whole reply "/streamcode" streams: prose, a long TypeScript block, prose. */
export const STREAMED_CODE_REPLY = `Here is the parser, written out as I go:\n\n\`\`\`ts\n${STREAMED_FUNCTION.repeat(STREAMED_REPEATS)}\`\`\`\n\nThat is all of it.`;

/** How many characters of the reply each tick of "/streamcode" sends. */
export const STREAMED_CODE_CHARS_PER_TICK = 12;
