// NoteEditor component - CodeMirror 6 based editor for patto notes.
// CodeMirror only renders the visible lines, so even a 12k-line note opens
// instantly (a <textarea> needs ~1 s to lay out that much CJK text). Mounted on
// the first Edit and kept (hidden) while previewing so cursor/scroll survive.

import { useStore } from '../lib/store';
import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import './NoteEditor.css';

// Patto nests with literal tab characters
const insertTab = (view) => {
    view.dispatch(view.state.replaceSelection('\t'));
    return true;
};

const theme = EditorView.theme(
    {
        '&': { height: '100%', backgroundColor: '#1a1a2e', color: '#f1f1f1' },
        '.cm-scroller': {
            fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
            fontSize: '14px',
            lineHeight: '1.6',
            padding: '16px 0',
        },
        '.cm-content': { padding: '0 16px', caretColor: '#e94560' },
        '.cm-line': { padding: '0' },
        '&.cm-focused': { outline: 'none' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e94560' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
            backgroundColor: '#0f3460',
        },
        '.cm-placeholder': { color: '#666' },
    },
    { dark: true },
);

export function NoteEditor() {
    const {
        currentNote,
        noteContent,
        isEditing,
        setNoteContent,
        saveNote,
        toggleEdit,
        goBack,
    } = useStore();

    const hostRef = useRef(null);
    const viewRef = useRef(null);
    // Text we last pushed to the store; lets us tell our own updates from external ones
    const emittedRef = useRef(null);
    const [opened, setOpened] = useState(isEditing);

    // Mount on first Edit; drop the editor when another note is opened
    useEffect(() => {
        if (isEditing) setOpened(true);
    }, [isEditing]);
    useEffect(() => {
        if (!isEditing) setOpened(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentNote]);

    // Create the editor once per mount
    useEffect(() => {
        if (!opened || !hostRef.current) return;
        const view = new EditorView({
            state: EditorState.create({
                doc: noteContent,
                extensions: [
                    history(),
                    keymap.of([{ key: 'Tab', run: insertTab }, ...historyKeymap, ...defaultKeymap]),
                    EditorView.lineWrapping,
                    EditorView.contentAttributes.of({
                        spellcheck: 'false',
                        autocorrect: 'off',
                        autocapitalize: 'off',
                    }),
                    placeholder('Start writing...'),
                    theme,
                    EditorView.updateListener.of((update) => {
                        if (!update.docChanged) return;
                        const text = update.state.doc.toString();
                        emittedRef.current = text;
                        setNoteContent(text);
                    }),
                ],
            }),
            parent: hostRef.current,
        });
        viewRef.current = view;
        emittedRef.current = noteContent;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    // External content changes (e.g. a restored history entry) replace the document
    useEffect(() => {
        const view = viewRef.current;
        if (!view || noteContent === emittedRef.current) return;
        emittedRef.current = noteContent;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: noteContent } });
    }, [noteContent]);

    // Focus when shown, release the keyboard when hidden
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (isEditing) view.focus();
        else view.contentDOM.blur();
    }, [isEditing, opened]);

    // Auto-save on debounce
    useEffect(() => {
        const timer = setTimeout(() => {
            saveNote();
        }, 1000);
        return () => clearTimeout(timer);
    }, [noteContent, saveNote]);

    const noteName = currentNote?.replace(/\.pn$/, '') || 'Note';

    if (!opened) return null;

    return (
        <div className={`note-editor${isEditing ? '' : ' hidden'}`} aria-hidden={!isEditing}>
            <header className="editor-header">
                <button className="back-btn" onClick={goBack}>
                    ← Back
                </button>
                <h1 className="editor-title">{noteName}</h1>
                <button className="preview-btn" onClick={toggleEdit}>
                    Preview
                </button>
            </header>

            <div ref={hostRef} className="editor-host" />

            <footer className="editor-footer">
                <span className="save-status">Auto-saving...</span>
            </footer>
        </div>
    );
}
