/** Sprint 5 Pass 6 (comment 13) — the atomic citation node: "editing prose
 * never corrupts a marker." atom:true + no text content means ProseMirror
 * treats it as one unsplittable unit — a backspace/selection can only
 * delete it whole, never eat into the middle of a title. The rendered
 * number comes from a numbering map computed fresh on every render by
 * DraftEditor.tsx (citationUtils.computeNumbering) — this node never
 * stores or owns a number itself, so there is nothing to get stale. */
import React, { createContext, useContext } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import { citationKey } from "./citationUtils.js";

/** Numbers live OUTSIDE the ProseMirror document (a React Context the
 * parent DraftEditor recomputes on every edit via computeNumbering) —
 * simpler and cheaper than mutating node attrs through a transaction on
 * every keystroke just to keep a displayed number in sync. */
export const CitationNumberContext = createContext<Map<string, number>>(new Map());

function CitationView({ node }: any) {
  const title: string = node.attrs.title;
  const resolved: boolean = node.attrs.resolved;
  const numbers = useContext(CitationNumberContext);
  const number = numbers.get(citationKey(title));
  return (
    <NodeViewWrapper as="span" className={"citation-node" + (resolved ? "" : " citation-unresolved")}
      title={title} contentEditable={false}>
      {resolved ? `[${number ?? "?"}]` : `[[${title}]]`}
    </NodeViewWrapper>
  );
}

export const CitationNode = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      title: { default: "" },
      resolved: { default: true },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-citation]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Static fallback (non-interactive contexts only — the live editor
    // always uses the React NodeView above, which resolves a real number
    // from CitationNumberContext).
    return ["span", mergeAttributes(HTMLAttributes, { "data-citation": node.attrs.title }),
      `[[${node.attrs.title}]]`];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CitationView);
  },
});
