import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// oxlint-disable-next-line import/default -- Vite's ?worker transform supplies the default Worker constructor.
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
// oxlint-disable-next-line import/default -- Vite's ?worker transform supplies the default Worker constructor.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
// oxlint-disable-next-line import/default -- Vite's ?worker transform supplies the default Worker constructor.
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
// oxlint-disable-next-line import/default -- Vite's ?worker transform supplies the default Worker constructor.
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
// oxlint-disable-next-line import/default -- Vite's ?worker transform supplies the default Worker constructor.
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

interface MonacoEnvironment {
  readonly getWorker: (_moduleId: string, label: string) => Worker;
}

const target = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment };
target.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
