import type { ReactNode } from 'react';

/** 小型安全排版：全部由 React 文本节点渲染，不接受模型生成的 HTML。 */
export default function RichText({ text, onCitation }: { text: string; onCitation?: (index: number) => void }) {
  const inline = (value: string): ReactNode[] => value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^\[\d+\]$/.test(part) && onCitation) return <button key={index} className="inline-citation" onClick={() => onCitation(Number(part.slice(1, -1)) - 1)}>{part}</button>;
    return part;
  });
  const blocks: ReactNode[] = []; const lines = text.split('\n'); let list: string[] = [], paragraph: string[] = [], code: string[] | null = null;
  const flush = () => {
    if (paragraph.length) { blocks.push(<p key={blocks.length}>{inline(paragraph.join('\n'))}</p>); paragraph = []; }
    if (list.length) { blocks.push(<ul key={blocks.length}>{list.map((line, index) => <li key={index}>{inline(line)}</li>)}</ul>); list = []; }
  };
  for (const line of lines) {
    if (line.startsWith('```')) { if (code) { blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>); code = null; } else { flush(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)/), bullet = line.match(/^\s*(?:[-*•]|\d+[.)、])\s+(.+)/);
    if (!line.trim()) flush();
    else if (heading) { flush(); blocks.push(<h3 key={blocks.length}>{inline(heading[1])}</h3>); }
    else if (bullet) { if (paragraph.length) flush(); list.push(bullet[1]); }
    else { if (list.length) flush(); paragraph.push(line); }
  }
  flush(); if (code) blocks.push(<pre key={blocks.length}>{code.join('\n')}</pre>);
  return <div className="rich-text">{blocks}</div>;
}
