import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('bash', bash);
hljs.registerAliases(['sh', 'shell'], { languageName: 'bash' });
hljs.registerLanguage('javascript', javascript);
hljs.registerAliases(['js', 'mjs'], { languageName: 'javascript' });
hljs.registerLanguage('json', json);
hljs.registerLanguage('typescript', typescript);
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerLanguage('xml', xml);
hljs.registerAliases(['html'], { languageName: 'xml' });

/** Returns the HTML of a code snippet with its tokens marked up, or the escaped source for an unknown language. */
export function highlight(code: string, language: string | undefined): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
  return code.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
