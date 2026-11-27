// A file a conversation names whose bytes this computer does not have: an attachment or a tool's picture in a session
// that runs on another computer (account-sessions.md, section 19). The account holds conversations, not their files
// (unless the person switched that on there, and even then they are not read here yet), so the page says what is
// missing and where it is, by name, instead of a broken picture: "Its file is on Mac mini."
import { createContext, useContext } from 'react';
import { FileText, ImageOff } from 'lucide-react';

/** The computer a conversation's files are on, when they are not on this one; null for a session here. */
export const FilesElsewhere = createContext<string | null>(null);

/** Where this conversation's files are, when they are on another computer. */
export const useFilesElsewhere = (): string | null => useContext(FilesElsewhere);

export function HeldElsewhere({ names, machine, pictures = true }: { names: readonly string[]; machine: string; pictures?: boolean }) {
  const Icon = pictures ? ImageOff : FileText;
  return (
    <div className="held-elsewhere" role="note">
      {names.map((name, i) => (
        <span key={`${i}-${name}`} className="held-elsewhere-name">
          <Icon aria-hidden />
          {name}
        </span>
      ))}
      <span className="held-elsewhere-where">{names.length === 1 ? 'Its file is' : 'Their files are'} on {machine}.</span>
    </div>
  );
}
