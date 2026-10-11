import { useCallback, useEffect, useRef, useState } from 'react';
import type { Mimic } from '@mimic-js/runtime';
import { EDITOR_THEME, monaco } from './monaco';

const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

type OpenDocument = {
  readonly model: monaco.editor.ITextModel;
  /** The model's version when it last matched the file. */
  savedVersion: number;
  viewState: monaco.editor.ICodeEditorViewState | null;
};

type EditorPaneProps = {
  readonly container: Mimic;
  /** Changes whenever the container's files may have changed. */
  readonly filesVersion: number;
  readonly tabs: readonly string[];
  readonly activePath: string | undefined;
  readonly onSelect: (path: string) => void;
  readonly onClose: (path: string) => void;
};

/** Tabs over one Monaco editor; a file is written to the container when it is saved. */
export function EditorPane({ container, filesVersion, tabs, activePath, onSelect, onClose }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>();
  const documents = useRef(new Map<string, OpenDocument>());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  /** Why a tab has no editable text, by path. */
  const [unavailable, setUnavailable] = useState<ReadonlyMap<string, string>>(new Map());

  const refreshDirty = useCallback((path: string) => {
    const document = documents.current.get(path);
    const isDirty = document !== undefined && document.model.getAlternativeVersionId() !== document.savedVersion;
    setDirty((current) => {
      if (current.has(path) === isDirty) return current;
      const next = new Set(current);
      if (isDirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    const document = activePath === undefined ? undefined : documents.current.get(activePath);
    if (activePath === undefined || !document) return;
    const version = document.model.getAlternativeVersionId();
    await container.fs.writeFile(activePath, document.model.getValue());
    document.savedVersion = version;
    refreshDirty(activePath);
  }, [activePath, container, refreshDirty]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const openDocuments = documents.current;
    const editor = monaco.editor.create(hostRef.current!, {
      model: null,
      theme: EDITOR_THEME,
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    editorRef.current = editor;
    return () => {
      editor.dispose();
      for (const document of openDocuments.values()) document.model.dispose();
      openDocuments.clear();
    };
  }, []);

  // Shows the active tab, reading its file the first time.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (activePath === undefined) {
      editor.setModel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      let document = documents.current.get(activePath);
      if (!document) {
        const file = await readTextFile(container, activePath);
        if (cancelled) return;
        if ('unavailable' in file) {
          setUnavailable((current) => new Map(current).set(activePath, file.unavailable));
          editor.setModel(null);
          return;
        }
        const model = monaco.editor.createModel(file.text, undefined, monaco.Uri.file(activePath));
        document = { model, savedVersion: model.getAlternativeVersionId(), viewState: null };
        model.onDidChangeContent(() => refreshDirty(activePath));
        documents.current.set(activePath, document);
      }
      editor.setModel(document.model);
      editor.restoreViewState(document.viewState);
      editor.focus();
    })();
    return () => {
      cancelled = true;
      const document = documents.current.get(activePath);
      if (document && editor.getModel() === document.model) document.viewState = editor.saveViewState();
    };
  }, [activePath, container, refreshDirty]);

  // Forgets the tabs that were closed.
  useEffect(() => {
    for (const [path, document] of documents.current) {
      if (tabs.includes(path)) continue;
      document.model.dispose();
      documents.current.delete(path);
    }
    setDirty((current) => new Set([...current].filter((path) => tabs.includes(path))));
    setUnavailable((current) => new Map([...current].filter(([path]) => tabs.includes(path))));
  }, [tabs]);

  // Follows a change a program made to the active file, unless it has unsaved edits.
  useEffect(() => {
    if (activePath === undefined) return;
    let cancelled = false;
    void readTextFile(container, activePath).then((file) => {
      const document = documents.current.get(activePath);
      if (cancelled || !document || !('text' in file)) return;
      if (document.model.getAlternativeVersionId() !== document.savedVersion) return;
      if (document.model.getValue() === file.text) return;
      document.model.setValue(file.text);
      document.savedVersion = document.model.getAlternativeVersionId();
    });
    return () => {
      cancelled = true;
    };
  }, [activePath, container, filesVersion]);

  const close = (path: string) => {
    if (dirty.has(path) && !window.confirm(`Discard the unsaved changes to ${baseName(path)}?`)) return;
    onClose(path);
  };

  const message =
    activePath === undefined ? 'Select a file to open it.' : unavailable.get(activePath);

  return (
    <section className="editor-pane" aria-label="Editor">
      <div className="tabs" role="tablist">
        {tabs.map((path) => (
          <div key={path} className="tab" role="tab" aria-selected={path === activePath} title={path}>
            <button type="button" className="tab-label" onClick={() => onSelect(path)}>
              {baseName(path)}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${baseName(path)}`}
              data-dirty={dirty.has(path) || undefined}
              onClick={() => close(path)}
            />
          </div>
        ))}
        {activePath !== undefined && dirty.has(activePath) && (
          <button type="button" className="save-button" onClick={() => void save()}>
            Save
          </button>
        )}
      </div>
      <div className="editor-body">
        <div ref={hostRef} className="editor-host" />
        {message !== undefined && <p className="editor-message">{message}</p>}
      </div>
    </section>
  );
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function readTextFile(
  container: Mimic,
  path: string
): Promise<{ readonly text: string } | { readonly unavailable: string }> {
  try {
    const bytes = await container.fs.readFile(path);
    if (bytes.byteLength > MAX_EDITABLE_BYTES) return { unavailable: 'This file is too large to edit here.' };
    if (bytes.subarray(0, 8000).includes(0)) return { unavailable: 'This is a binary file.' };
    return { text: new TextDecoder().decode(bytes) };
  } catch {
    return { unavailable: 'This file no longer exists.' };
  }
}
