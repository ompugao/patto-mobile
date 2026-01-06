// Note view hooks - lifecycle hooks for NOTE_VIEW and NOTE_EDIT
// Registers saveContext, onLeave, and onEnter hooks for note navigation

import { registerViewHooks } from './viewHooks';
import { View } from './constants';

// NOTE_VIEW hooks
registerViewHooks(View.NOTE_VIEW, {
    // Save current note context before navigating away
    saveContext: (state) => ({
        note: state.currentNote,
        content: state.noteContent,
        html: state.renderedHtml,
    }),

    // Clean up when leaving note view (only if not going to another note)
    onLeave: (state, actions) => ({
        currentNote: null,
        noteContent: '',
        renderedHtml: '',
        isEditing: false,
    }),

    // Restore note context when returning to a previous note
    onEnter: (context, state) => {
        if (context && context.note) {
            return {
                currentNote: context.note,
                noteContent: context.content || '',
                renderedHtml: context.html || '',
                isEditing: false,
            };
        }
        return {};
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
