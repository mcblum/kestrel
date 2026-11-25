// Agent text as markdown: tables, lists, code. Raw HTML in the text is not rendered. Code blocks
// get Copy, and in a session a shell block also gets Run (CodeBlock.tsx).
// A picture pointing at a local file is fetched through the session's `raw` route when the
// session is known, or drawn by the caller's `picture` (What's new); remote and inline pictures
// render as they are.
// In a session, a Markdown or PDF file the text names (an inline code span, or a link to a local
// path) opens in a tab of the session when clicked (shared/viewable-files.ts decides which). A link to
// one of the app's own pages (`#/settings/git`) opens that page in the app.
import { memo, useMemo, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../styles/markdown.css';
import { codeBlockFor } from './CodeBlock.tsx';
import { Thumb } from './Pictures.tsx';
import { viewablePathIn } from '@kestrel/server/viewable-files';
import { openSessionFile } from '../sessionView.ts';
import { isAppPage } from '@kestrel/server/routes';
import { opener } from '../route.ts';
import { tabActions } from '../tabsStore.ts';

const plugins = [remarkGfm];
const REMOTE = /^(https?:|data:|blob:)/i;

/** Keep `file:` picture sources and links (the default transform drops them); everything else as usual. */
const urlTransform: UrlTransform = (url, key) => ((key === 'src' || key === 'href') && /^file:/i.test(url) ? url : defaultUrlTransform(url));

/** A picture source as a path the server understands: `file://` stripped and decoded. */
function localPath(src: string): string {
  if (!/^file:/i.test(src)) return src;
  try {
    return decodeURIComponent(new URL(src).pathname);
  } catch {
    return src.replace(/^file:\/\//i, '');
  }
}

type LinkProps = ComponentProps<'a'> & { node?: unknown };

/** A link out opens outside Kestrel. `toAppPage` is how a link to one of the app's own pages opens. */
const linkWith = (toAppPage: (path: string, newTab: boolean) => void) =>
  function OutLink({ children, href, node: _node, ...props }: LinkProps) {
    if (href && isAppPage(href))
      return (
        <a {...props} href={href} {...opener((newTab) => toAppPage(href, newTab))} onClickCapture={(event) => event.preventDefault()}>
          {children}
        </a>
      );
    return (
      <a {...props} href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel={href?.startsWith('#') ? undefined : 'noreferrer'}>
        {children}
      </a>
    );
  };

/**
 * A link to one of the app's own pages (`#/settings/git`; shared/routes.ts `isAppPage`) opens it here,
 * as any in-app link does: a plain click in the tab in front, Cmd, shift or a middle click a new tab.
 */
const OutLink = linkWith((path, newTab) => tabActions.open({ kind: 'page', path }, newTab));
/** On What's new: every in-app link opens beside the notes in a tab of its own (or the tab already showing it), so they stay open. */
const BesideLink = linkWith((path) => tabActions.openBeside(path, true));

// Keep native table layout; only the surrounding region scrolls on narrow panes.
const table: Components['table'] = ({ children, node: _node, ...props }) => (
  <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}>
    <table {...props}>{children}</table>
  </div>
);

/** Draws a picture whose source is not remote, for text outside a session (What's new's own pictures). */
export type PictureOf = (src: string, alt: string) => ReactNode;

function componentsFor(sessionId: string | undefined, messageId: string | undefined, picture: PictureOf | undefined, linksBeside: boolean): Components {
  const pre = codeBlockFor(sessionId, messageId) as Components['pre'];
  const link = linksBeside ? BesideLink : OutLink;
  if (!sessionId && picture) {
    const img: Components['img'] = ({ src, alt }) => (typeof src !== 'string' || !src ? null : REMOTE.test(src) ? <img src={src} alt={alt ?? ''} /> : picture(src, alt ?? ''));
    return { a: link, pre, table, img };
  }
  if (!sessionId && linksBeside) return { a: link, pre, table };
  if (!sessionId) return { a: OutLink, pre, table };
  const img: Components['img'] = ({ src, alt }) => {
    if (typeof src !== 'string' || !src) return null;
    if (REMOTE.test(src)) return <img src={src} alt={alt ?? ''} />;
    return <Thumb sessionId={sessionId} kind="raw" name={localPath(src)} alt={alt} />;
  };
  // A link to a local Markdown or PDF file opens it here; any other link goes out as usual.
  const a = (props: LinkProps) => {
    const path = viewablePathIn(props.href ?? '');
    if (!path) return <OutLink {...props} />;
    const { children, node: _node, ...rest } = props;
    return (
      <a {...rest} href={props.href} title={`Open ${path} in a tab`} onClick={(event) => (event.preventDefault(), openSessionFile(sessionId, path))}>
        {children}
      </a>
    );
  };
  // An inline code span that names such a file is a button for it. (A fenced block is drawn by `pre`.)
  const code: Components['code'] = ({ children, node: _node, ...props }) => {
    const path = typeof children === 'string' ? viewablePathIn(children) : null;
    if (!path) return <code {...props}>{children}</code>;
    return (
      <button type="button" className="inline-file" title={`Open ${path} in a tab`} onClick={() => openSessionFile(sessionId, path)}>
        <code {...props}>{children}</code>
      </button>
    );
  };
  return { a, code, img, pre, table };
}

/**
 * `messageId`: the conversation message this text is, so its code blocks can be opened in a tab.
 * `picture`: how a local picture is drawn outside a session (a module-level function). `linksBeside`:
 * links to the app's pages open beside this one in a tab of their own (What's new).
 */
export const Markdown = memo(function Markdown({ text, sessionId, messageId, picture, linksBeside = false }: { text: string; sessionId?: string; messageId?: string; picture?: PictureOf; linksBeside?: boolean }) {
  const components = useMemo(() => componentsFor(sessionId, messageId, picture, linksBeside), [sessionId, messageId, picture, linksBeside]);
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});
