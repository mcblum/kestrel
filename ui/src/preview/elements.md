# A clear place to think

A complete specimen for Kestrel’s conversation typography. A paragraph should feel calm and readable, with **confident emphasis**, *a lighter aside*, ***both together***, and ~~a superseded idea~~. Inline `code` sits comfortably on the same baseline.

## Lists and their rhythm

Short lists stay compact:

- Read the current state.
- Make one focused change.
- Verify the result.

Longer items keep their supporting details close:

1. **Prepare the workspace.** Check the working tree and save anything you need before you begin. This sentence is intentionally long enough to wrap and demonstrate the hanging indent.
   - Keep related changes together.
   - Separate unrelated work.
     - A third level still has a clear text axis.
     - It should never feel like a wall of bullets.
2. **Review the result.** The next step is visibly distinct from the nested details above it.

Loose lists support more than one paragraph:

- **A considered first step.** Start with a small, reversible change.

  This second paragraph belongs to the same item. Its spacing should explain that relationship without extra decoration.

  > A quotation can also live inside a list.

- **A second step.** This is a new item, with a little more breathing room.

Ordered lists can resume at any number:

9. Review the changes.
10. Run the checks.
11. Share the result.

### Task lists

- [x] Read the requirements.
- [x] Implement the typography.
- [ ] Review light and dark themes, including a longer task that wraps onto a second line in a narrow conversation pane.
  - [ ] Check nested tasks too.

## Code, paths, and links

Use `pnpm dev:ui` to start the interface. Longer paths such as `src/components/conversation/markdown/fixtures/a-deliberately-long-filename-for-wrapping.tsx` should wrap gracefully without widening the page.

A [descriptive link](https://example.com) is easy to identify. GFM also recognizes https://example.com/a/long/path/that/should/wrap/without/pushing/the/conversation/outside/its/container.

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const summarize = (messages: Message[]) => {
  return messages.map(({ role, content }) => `${role}: ${content}`);
};
```

A long line scrolls inside its code block, leaving the conversation in place:

```sh
curl --request GET https://example.com/api/projects/kestrel/conversations/preview --header 'Accept: application/json' --header 'X-Request-ID: markdown-specimen'
```

    Indented code works too.
    Spaces and line breaks are preserved.

## Tables

| Element | Treatment | Status |
| :--- | :--- | ---: |
| Paragraph | Comfortable line height | Ready |
| Inline code | Quiet background | Ready |
| Nested list | Clear indentation | Ready |
| Task list | Native checkbox | Ready |

| Long configuration key | Example value | Explanation |
| :--- | :--- | :--- |
| `CONVERSATION_RENDERING_MAXIMUM_WIDTH` | `690px` | A wide table scrolls locally on smaller screens. |
| `MARKDOWN_PRESERVE_CODE_WHITESPACE` | `true` | Long code tokens stay intact inside table cells. |

## Quotations and separators

> Good typography makes the structure visible before you read the words.
>
> A second paragraph keeps its own rhythm.
>
> > A nested quotation is quieter still.

A horizontal rule marks a larger change of subject.

---

## Heading hierarchy

Body copy after a second-level heading.

### A third-level heading

Use these for subsections within a response.

#### A fourth-level heading

A smaller label still reads as a heading.

##### A fifth-level heading

Secondary, without becoming tiny.

###### A sixth-level heading

The least prominent heading remains readable.

## Images and footnotes

![Kestrel bird mark](/favicon.svg)

An image keeps its natural proportions. Footnotes are supported too.[^note]

Escaped characters stay literal: \*not italic\*, \# not a heading, and \[not a link\].

A hard line break ends here.  
This is the next line of the same paragraph.

[^note]: A compact note with a [source link](https://example.com) and a return link to its reference.
