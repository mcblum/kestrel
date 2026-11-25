// The title an agent gives a session it starts (`delegate` per task, `handoff`, `spawn`; 0.0.33, Matt:
// "some of the sub-agent threads in my workstream don't have easy-to-understand names"). It names the
// part as the user reads it in the sidebar ("Terraform: Cognito OAuth client"), not the ticket or an
// address. One place for the rule and its words; pure. With no title, the session is titled from its
// brief (`titleFrom`), which skips a leading ticket key and address too (title.ts).

/** The longest title an agent may give: a few words, one sidebar row. */
export const AGENT_TITLE_MAX = 60;

/** A ticket key alone, as trackers write them: "LH-140850", "ENG-12". */
export const TICKET_KEY = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
/** An address anywhere in the text. */
const URL = /\b(?:https?:\/\/|www\.)\S+/i;

/** The title to use (trimmed, spaces collapsed), or why it is refused. Undefined given: none, so the brief titles it. */
export function checkAgentTitle(given: string | undefined): { title: string | null } | { refusal: string } {
  if (given === undefined) return { title: null };
  const title = given.replace(/\s+/g, ' ').trim();
  if (!title) return { refusal: 'The title is empty. Give the part a few words the user will read in the sidebar, such as "Terraform: Cognito OAuth client", or leave title out.' };
  if (title.length > AGENT_TITLE_MAX) return { refusal: `The title "${title}" is ${title.length} characters; keep it to ${AGENT_TITLE_MAX}: a few words naming the part.` };
  if (TICKET_KEY.test(title)) return { refusal: `The title "${title}" is only a ticket key. Name what this part does, in a few words, such as "Terraform: Cognito OAuth client".` };
  if (URL.test(title)) return { refusal: `The title "${title}" contains an address. Name what this part does, in a few words, without a link.` };
  return { title };
}

/** Titles for the tasks of one call, in order (null: none given), or every reason one is refused, including two tasks titled alike. */
export function checkAgentTitles(given: readonly (string | undefined)[]): { titles: (string | null)[] } | { refusal: string } {
  const checked = given.map(checkAgentTitle);
  const problems = checked.flatMap((c, i) => ('refusal' in c ? [given.length > 1 ? `Task ${i + 1}: ${c.refusal}` : c.refusal] : []));
  const titles = checked.map((c) => ('title' in c ? c.title : null));
  const seen = new Map<string, number>();
  titles.forEach((t, i) => {
    if (t === null) return;
    const key = t.toLowerCase();
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i);
    else problems.push(`Tasks ${first + 1} and ${i + 1} are both titled "${t}". Give each part its own title, so the user can tell them apart.`);
  });
  return problems.length ? { refusal: problems.join('\n') } : { titles };
}
