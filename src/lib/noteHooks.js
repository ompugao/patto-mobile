// Note view hooks - lifecycle hooks for NOTE_VIEW and NOTE_EDIT
// Registers saveContext, onLeave, and onEnter hooks for note navigation

import { invoke } from '@tauri-apps/api/core';
import { registerViewHooks } from './viewHooks';
import { View } from './constants';
import * as noteCache from './noteCache';

// NOTE_VIEW hooks
registerViewHooks(View.NOTE_VIEW, {
    // Remember which note and where it was scrolled to; the rendered DOM itself
    // stays alive in noteCache, so nothing heavy is copied into history.
    saveContext: (state) => ({
        note: state.currentNote,
        scrollTop: noteCache.currentScrollTop(),
    }),

    // Clean up when leaving note view (overridden by onEnter when returning to another note)
    onLeave: () => ({
        currentNote: null,
        noteContent: '',
        renderedHtml: '',
        isEditing: false,
    }),

    // Restore a previous note. Uses the cached render; re-renders only if it was evicted.
    onEnter: async (context, state) => {
        if (!context || !context.note) return {};

        let entry = noteCache.getNote(context.note);
        if (!entry) {
            const result = await invoke('render_note', {
                root: state.workspacePath,
                filePath: context.note,
            });
            entry = noteCache.setNote(context.note, { content: result.rawContent, html: result.html });
        }

        return {
            currentNote: context.note,
            noteContent: entry.content,
            renderedHtml: entry.html,
            isEditing: false,
            noteTarget: { scrollTop: context.scrollTop ?? 0, anchor: null, seq: Date.now() },
        };
    },
});

// NOTE_EDIT hooks
registerViewHooks(View.NOTE_EDIT, {
    // Auto-save before leaving edit mode
    onLeave: async (state, actions) => {
        if (state.isEditing) {
            await actions.saveNote();
        }
        return { isEditing: false };
    },

    // No special onEnter - edit mode is entered via toggleEdit
});
