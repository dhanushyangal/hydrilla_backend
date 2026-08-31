import { filterXSS, whiteList as defaultWhiteList } from "xss";

const blogWhiteList: typeof defaultWhiteList = {
  ...defaultWhiteList,
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  p: [],
  br: [],
  strong: [],
  em: [],
  a: ["href", "title", "target", "rel"],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  pre: [],
  code: [],
  img: ["src", "alt", "title", "width", "height"],
  hr: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
};

export function sanitizeBlogHtml(html: string): string {
  return filterXSS(html, {
    whiteList: blogWhiteList,
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style"],
  });
}
