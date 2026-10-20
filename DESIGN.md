# Jason Mail Design Notes

## Visual tokens

| Token | Value | Use |
| --- | --- | --- |
| Court purple | `#552583` | Brand actions and selected navigation |
| Deep plum | `#24143E` | Dark shell and high emphasis |
| Lakers gold | `#FDB927` | Primary call to action, stars, quota highlights |
| Paper | `#F7F5F1` | Reading canvas |
| White | `#FFFFFF` | Message and form surfaces |
| Ink | `#292333` | Primary text |

Use native system fonts with CJK fallbacks. Prefer sentence case, compact headings, readable message line length, and tabular figures for mailbox counts and chat codes. Gold is an action signal, not a decorative background for long text. Use a visible purple focus ring and respect reduced-motion settings.

## Layout

On desktop, the folder rail stays narrow, the message list stays scannable, and the selected message gets the largest pane. On phones, show a single pane at a time and keep navigation inside a drawer. Setup and login place the form beside a single original envelope illustration; the illustration does not compete with form labels.

```text
Desktop
┌─────────────────────────────────────────────────────────────┐
│ Brand / Search / Domain / Admin                              │
├───────────┬────────────────────┬─────────────────────────────┤
│ Folders   │ Message list       │ Reading pane                │
│ Compose   │ Sender / subject   │ Subject, body, attachments  │
│ Settings  │ Time / star        │ Reply actions               │
└───────────┴────────────────────┴─────────────────────────────┘

Phone
┌────────────────────────────┐
│ Menu / Search / Compose    │
├────────────────────────────┤
│ One mailbox or message pane│
└────────────────────────────┘
```

## Principles

- Mail is the primary job; settings and chat stay one step away.
- Gold highlights the next action and the current selection.
- Purple supplies the brand while paper and white keep long messages calm.
- Empty and error states tell the user what to do next.
- Use an original envelope-and-court-line motif; do not use Lakers marks or Kobe likeness. Keep the one soft halo behind the envelope; avoid gradient washes elsewhere.
- Keep dependencies and network-loaded assets out of the first-run experience.

## Review against the brief

The approved visual direction already calls for purple and gold, so the distinctive choice is a restrained mailroom interface with a court-line envelope mark, not a sports poster. The interface avoids external fonts and heavy motion to remain fast and readable on phones and on a free Worker deployment.
