import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Compartment, Prec } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { isDark, onThemeChange } from './theme.js';

// Light theme drawn from the page tokens so the editor reads as part of the bench paper.
const paper = EditorView.theme({
  '&': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--paper)', color: 'var(--ink-3)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,228,92,0.18)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--tape)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,228,92,0.45)' },
});

// Earlier extensions take precedence, so the paper-coloured override goes before oneDark.
const night = [
  EditorView.theme(
    {
      '&': { backgroundColor: 'var(--paper)' },
      '.cm-gutters': { backgroundColor: 'var(--paper)', border: 'none' },
    },
    { dark: true },
  ),
  oneDark,
];

const base = EditorView.theme({
  '&': { fontSize: '13.5px', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0' },
  '.cm-gutterElement': { paddingLeft: '10px !important' },
});

/**
 * @param parent   element to mount into
 * @param doc      initial source
 * @param handlers {onChange, onRun, onEvaluate}
 */
export function createEditor(parent, doc, handlers) {
  const theme = new Compartment();
  const pick = () => (isDark() ? night : paper);

  const runKeys = Prec.highest(
    keymap.of([
      { key: 'Mod-Enter', run: () => (handlers.onRun(), true) },
      { key: 'Mod-Shift-Enter', run: () => (handlers.onEvaluate(), true) },
    ]),
  );

  const view = new EditorView({
    doc,
    parent,
    extensions: [
      runKeys,
      basicSetup,
      keymap.of([indentWithTab]),
      indentUnit.of('    '),
      python(),
      base,
      theme.of(pick()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) handlers.onChange(u.state.doc.toString());
      }),
      EditorView.contentAttributes.of({ 'aria-label': 'controller.py source code' }),
    ],
  });
  onThemeChange(() => view.dispatch({ effects: theme.reconfigure(pick()) }));

  return {
    get value() {
      return view.state.doc.toString();
    },
    set value(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
  };
}
