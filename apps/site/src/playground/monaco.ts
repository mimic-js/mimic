import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

const languageWorkers: Record<string, new () => Worker> = {
  css: CssWorker,
  scss: CssWorker,
  less: CssWorker,
  html: HtmlWorker,
  handlebars: HtmlWorker,
  razor: HtmlWorker,
  json: JsonWorker,
  typescript: TypeScriptWorker,
  javascript: TypeScriptWorker
};

self.MonacoEnvironment = {
  getWorker: (_moduleId, label) => new (languageWorkers[label] ?? EditorWorker)()
};

// A model is one file without its project, so imports and types never resolve:
// only syntax is checked.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });

export const EDITOR_THEME = 'mimic-playground';

monaco.editor.defineTheme(EDITOR_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0e1612',
    'editorGutter.background': '#0e1612',
    'editor.lineHighlightBackground': '#16221c',
    'editorLineNumber.foreground': '#4f6358'
  }
});

export { monaco };
