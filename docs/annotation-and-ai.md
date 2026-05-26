# Annotation And AI Design

## Product Model

The core object is an annotation, not a detached note.

```ts
type PaperAnnotation = {
  page: number;
  rect: { x: number; y: number; width: number; height: number };
  color: string;
  style: "highlight" | "underline" | "box";
  hasNote: boolean;
  note: string;
};
```

The first prototype stores `rect` in normalized page coordinates. This makes annotations survive zoom changes. The next version should add PDF text ranges so a highlight can follow reflowed or rerendered text more precisely.

## Reading Flow

1. Import PDF.
2. Read directly on the page.
3. Drag with the annotation pen.
4. The app creates an annotation-only mark and shows a small add-note button near the stroke end.
5. Clicking elsewhere hides the button and keeps the mark annotation-only.
6. Clicking the add-note button creates a side note editor for that mark.
7. Edits are saved automatically.
8. Selecting either the page mark or the side note highlights the matching pair.

## AI Flow

Assistant actions should be attached to the same annotation object:

- Translate selected text.
- Explain a confusing sentence.
- Ask a custom question.
- Append the answer to the note or save it as an AI result card.

Provider order:

1. Mock provider for interface development.
2. Offline local provider for basic translation.
3. Cloud model provider for high-quality translation and reasoning.

The UI should keep AI output in the right panel so it does not cover the paper.
