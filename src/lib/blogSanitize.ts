import xss from "xss";

const blogWhiteList: Record<string, string[]> = {
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
  return xss(html, {
    whiteList: blogWhiteList,
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style"],
  });
}
