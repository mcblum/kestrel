// Agent text as markdown: tables, lists, code. Raw HTML in the text is not rendered. Code blocks
// get Copy, and in a session a shell block also gets Run (CodeBlock.tsx).
// A picture pointing at a local file is fetched through the session's `raw` route when the
// session is known; remote and inline pictures render as they are.
import { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../styles/markdown.css';
import { codeBlockFor } from './CodeBlock.tsx';
import { Thumb } from './Pictures.tsx';

const plugins = [remarkGfm];
const REMOTE = /^(https?:|data:|blob:)/i;

/** Keep `file:` picture sources (the default transform drops them); everything else as usual. */
const urlTransform: UrlTransform = (url, key) => (key === 'src' && /^file:/i.test(url) ? url : defaultUrlTransform(url));

/** A picture source as a path the server understands: `file://` stripped and decoded. */
function localPath(src: string): string {
  if (!/^file:/i.test(src)) return src;
  try {
    return decodeURIComponent(new URL(src).pathname);
  } catch {
    return src.replace(/^file:\/\//i, '');
  }
}

const link: Components['a'] = ({ children, href, node: _node, ...props }) => (
  <a {...props} href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel={href?.startsWith('#') ? undefined : 'noreferrer'}>
    {children}
  </a>
);

// Keep native table layout; only the surrounding region scrolls on narrow panes.
const table: Components['table'] = ({ children, node: _node, ...props }) => (
  <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}>
    <table {...props}>{children}</table>
  </div>
);

function componentsFor(sessionId: string | undefined, messageId: string | undefined): Components {
  const pre = codeBlockFor(sessionId, messageId) as Components['pre'];
  if (!sessionId) return { a: link, pre, table };
  const img: Components['img'] = ({ src, alt }) => {
    if (typeof src !== 'string' || !src) return null;
    if (REMOTE.test(src)) return <img src={src} alt={alt ?? ''} />;
    return <Thumb sessionId={sessionId} kind="raw" name={localPath(src)} alt={alt} />;
  };
  return { a: link, img, pre, table };
}

/** `messageId`: the conversation message this text is, so its code blocks can be opened in a tab. */
export const Markdown = memo(function Markdown({ text, sessionId, messageId }: { text: string; sessionId?: string; messageId?: string }) {
  const components = useMemo(() => componentsFor(sessionId, messageId), [sessionId, messageId]);
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});
