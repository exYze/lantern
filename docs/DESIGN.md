# Lantern's design

## The brief

- **Who it's for:** people who run their own models and want bots that do real work on their own
  machines.
- **How it should feel:** a well-made tool you own outright. Sturdy, plainly labeled, quiet until it needs
  you.
- **Reference:** a Dietz hurricane lantern and the page of the hardware-store catalogue that sells it.
  Painted enamel steel, a kerosene flame, and stamped type that says what each part does.

Every choice below traces back to that.

## Type

**Archivo** for everything you read, using its semi-condensed width (`--stamp`) for headings and the small
upper-case labels. It's a sturdy grotesque cut for print, so headings look stamped rather than styled.
**IBM Plex Mono** for the commands, paths and model names bots work with: the machine's voice. Both are
bundled (SIL Open Font License), so the app never fetches fonts.

## Color

| | Light | Dark | Used for |
|---|---|---|---|
| Enamel green | `#1f3b2f` | `#16291f` | The sidebar, onboarding panel, site header. The lantern's painted body. |
| Ink | `#191d1b` | `#e6ebe7` | Text, rules, selected states. |
| Paper | `#f6f6f3` | `#121614` | Backgrounds. Neutral, not beige. |
| Flame | `#bf4512` | `#f08a3c` | Only where you act: the main button, Send, focus, and approvals. |

All text passes WCAG AA. Avatars use enamel paint colors; features switch to a light color on dark paint.

## Layout

- Hierarchy comes from type size, rules and whitespace, not boxes. Lists (templates, presets, routines,
  skills, approval modes, downloads) are catalogue rows with hairlines, not grids of cards.
- Tool activity in a chat is a work log: one line per action, details folded underneath, subagent steps
  indented. Nothing is a card inside a card.

## The signature

**An approval is a shipping tag.** When a bot wants to run a command or change a file, a tag hangs off
that line of its work by a flame-colored string, with a punched hole. Lantern's promise is that bots ask
before they act, so the one thing that waits on you looks like a thing you'd sign for. On the website the
tag hangs from a nail and takes a stamp when you answer it.

## Never use

These make software look machine-made. Check new UI against the list before it ships:

- purple, violet or blue-to-purple gradients, or gradient text
- Inter, Roboto, Poppins or Geist as the only typeface
- a pill badge above a headline ("New", "Introducing")
- glows, halos or blurred color blobs
- frosted glass
- an icon in a rounded square above every heading
- rows of three identical feature cards
- cards nested inside cards
- a colored stripe down one side of every card
- giant stat numbers with tiny labels
- tiny numbered section labels (01, 02, 03)
- pulsing status dots
- em dashes, and filler like seamless, effortless, world-class, next-level
- beige backgrounds with an italic serif headline

Write copy like the person who made the app talking to one user: short sentences, concrete nouns, no
invented numbers.
