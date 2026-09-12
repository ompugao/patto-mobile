// Zustand store for patto-mobile
// Manages app state: workspace, files, current note, git status
// Persists key settings to localStorage

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { callSaveContext, callOnLeave, callOnEnter } from './viewHooks';
import { View, SortBy } from './constants';
import * as noteCache from './noteCache';

// Re-export for backwards compatibility
export { View, SortBy };

// Import hooks to register them (must be after View is available)
import './noteHooks';

// Copy of the history with the current (last) entry merged with `context` (if any)
function withSavedContext(viewHistory, context) {
    const history = [...viewHistory];
    if (context && history.length > 0) {
        history[history.length - 1] = { ...history[history.length - 1], ...context };
    }
    return history;
}

export const useStore = create(
    persist(
        (set, get) => ({
            // === Workspace ===
            workspacePath: null,

            // === View State ===
            currentView: View.FILE_LIST,
            // Navigation history stack - stores objects with view and context
            // e.g., { view: 'note_view', note: 'file.pn', content: '...', html: '...' }
            viewHistory: [{ view: View.FILE_LIST }],

            // === Files ===
            files: [],
            sortBy: SortBy.LAST_MODIFIED,
            isLoadingFiles: false,

            // === Current Note ===
            currentNote: null,
            noteContent: '',
            renderedHtml: '',
            isEditing: false,
            // Where NoteView should scroll once the note is shown:
            // { scrollTop, anchor, seq } (seq makes repeated identical targets re-apply)
            noteTarget: null,
            // Scroll position of the note when the editor was opened (restored on Preview)
            editReturnScrollTop: 0,

            // === Lightbox (full-size image viewer over the note view) ===
            lightbox: null, // { src, alt } | null

            // === Tasks ===
            tasks: null,
            isLoadingTasks: false,

            // === Git ===
            gitStatus: null,
            gitCredentials: { username: '', token: '' },
            isGitSyncing: false,

            // === Actions ===

            setWorkspacePath: (path) => set({ workspacePath: path }),

            // Basic view setter (for internal use, e.g., popstate handler)
            setView: (view) => set({ currentView: view }),

            // Navigate to a new view with history tracking
            navigateTo: (view, pushToHistory = true) => {
                const { viewHistory, currentView } = get();
                if (view === currentView) return;

                const entry = { view };
                const newHistory = [...viewHistory, entry];
                set({ currentView: view, viewHistory: newHistory });

                if (pushToHistory) {
                    history.pushState({ view, index: newHistory.length - 1 }, '', '');
                }
            },

            // Go back to previous view (called by popstate handler)
            goBack: async () => {
                const state = get();
                const { viewHistory, currentView } = state;

                if (viewHistory.length <= 1) {
                    // At root, allow app to close (return false to indicate no navigation)
                    return false;
                }

                // Call onLeave hook for current view
                const leaveUpdates = await callOnLeave(currentView, state, {
                    saveNote: get().saveNote,
                });

                // Pop current view and go to previous
                const newHistory = viewHistory.slice(0, -1);
                const previousEntry = newHistory[newHistory.length - 1];
                const previousView = previousEntry.view;

                // Call onEnter hook for previous view (with saved context)
                const enterUpdates = await callOnEnter(previousView, previousEntry, state);

                // Apply all updates
                set({
                    ...leaveUpdates,
                    ...enterUpdates,
                    currentView: previousView,
                    viewHistory: newHistory,
                });

                return true;
            },

            // Initialize history state (called on app mount)
            initializeHistory: () => {
                history.replaceState({ view: View.FILE_LIST, index: 0 }, '', '');
                set({ viewHistory: [{ view: View.FILE_LIST }] });
            },

            setSortBy: async (sortBy) => {
                set({ sortBy });
                await get().loadFiles();
            },

            // Load file list
            loadFiles: async () => {
                const { workspacePath, sortBy } = get();
                if (!workspacePath) return;

                set({ isLoadingFiles: true });
                try {
                    const files = await invoke('list_files', { root: workspacePath, sortBy });
                    set({ files, isLoadingFiles: false });
                } catch (error) {
                    console.error('Failed to load files:', error);
                    set({ isLoadingFiles: false });
                }
            },

            // Open a note, optionally jumping to an anchor (wikilink `note.pn#anchor`).
            // Always re-renders from disk so edits/syncs are picked up; the DOM is only
            // rebuilt when the rendered HTML actually changed.
            openNote: async (filePath, anchor = null) => {
                const state = get();
                const { workspacePath, currentView, viewHistory } = state;
                if (!workspacePath) return;

                // Save the current view's context (e.g. scroll position) before we leave it
                const savedContext = callSaveContext(currentView, state);

                try {
                    const result = await invoke('render_note', {
                        root: workspacePath,
                        filePath
                    });
                    const entry = noteCache.setNote(filePath, { content: result.rawContent, html: result.html });

                    const newHistory = withSavedContext(viewHistory, savedContext);
                    newHistory.push({ view: View.NOTE_VIEW });

                    set({
                        currentNote: filePath,
                        noteContent: entry.content,
                        renderedHtml: entry.html,
                        noteTarget: { scrollTop: 0, anchor, seq: Date.now() },
                        currentView: View.NOTE_VIEW,
                        viewHistory: newHistory,
                        isEditing: false,
                    });
                    history.pushState({ view: View.NOTE_VIEW, index: newHistory.length - 1 }, '', '');
                } catch (error) {
                    console.error('Failed to open note:', error);
                }
            },

            // Open the full-size image viewer. Pushes a history entry so the
            // hardware/browser back button closes it instead of leaving the note.
            openLightbox: (image) => {
                set({ lightbox: image });
                history.pushState({ view: get().currentView, lightbox: true }, '', '');
            },

            // Close the viewer by popping its history entry (see App popstate handler)
            closeLightbox: () => {
                if (get().lightbox) history.back();
            },

            // Toggle edit mode
            toggleEdit: () => {
                const state = get();
                const { isEditing, viewHistory, currentView } = state;
                const newView = isEditing ? View.NOTE_VIEW : View.NOTE_EDIT;
                // Remember the scroll position so both Back and Preview from the editor
                // land where we were
                const savedContext = callSaveContext(currentView, state);
                const newHistory = withSavedContext(viewHistory, savedContext);
                newHistory.push({ view: newView });
                set({
                    isEditing: !isEditing,
                    currentView: newView,
                    viewHistory: newHistory,
                    ...(isEditing
                        ? { noteTarget: { scrollTop: state.editReturnScrollTop ?? 0, anchor: null, seq: Date.now() } }
                        : { editReturnScrollTop: savedContext?.scrollTop ?? 0 }),
                });
                history.pushState({ view: newView, index: newHistory.length - 1 }, '', '');
            },

            // Update note content (while editing)
            setNoteContent: (content) => set({ noteContent: content }),

            // Save note
            saveNote: async () => {
                const { workspacePath, currentNote, noteContent } = get();
                if (!workspacePath || !currentNote) return;

                try {
                    await invoke('write_note', {
                        root: workspacePath,
                        filePath: currentNote,
                        content: noteContent
                    });
                    // Re-render after save (drops the cached DOM if the HTML changed)
                    const html = await invoke('render_content', { root: workspacePath, content: noteContent });
                    noteCache.setNote(currentNote, { content: noteContent, html });
                    set({ renderedHtml: html });
                } catch (error) {
                    console.error('Failed to save note:', error);
                }
            },

            // Close note and go back to file list
            closeNote: () => {
                set({
                    currentNote: null,
                    noteContent: '',
                    renderedHtml: '',
                    noteTarget: null,
                    isEditing: false,
                    currentView: View.FILE_LIST,
                    viewHistory: [{ view: View.FILE_LIST }], // Reset history when explicitly closing
                });
                history.replaceState({ view: View.FILE_LIST, index: 0 }, '', '');
            },

            // Load tasks
            loadTasks: async () => {
                const { workspacePath } = get();
                if (!workspacePath) return;

                set({ isLoadingTasks: true });
                try {
                    const tasks = await invoke('get_all_tasks', { root: workspacePath });
                    set({ tasks, isLoadingTasks: false });
                } catch (error) {
                    console.error('Failed to load tasks:', error);
                    set({ isLoadingTasks: false });
                }
            },

            // Git actions
            setGitCredentials: (credentials) => set({ gitCredentials: credentials }),

            gitSync: async () => {
                const { workspacePath, gitCredentials } = get();
                if (!workspacePath) return;

                set({ isGitSyncing: true });
                try {
                    // Pull first, then sync
                    await invoke('git_pull', { repoPath: workspacePath, credentials: gitCredentials });
                    await invoke('git_sync', {
                        repoPath: workspacePath,
                        message: 'Sync from patto-mobile',
                        credentials: gitCredentials
                    });
                    // Files may have changed on disk: drop cached renders, reload list
                    noteCache.clear();
                    await get().loadFiles();
                } catch (error) {
                    console.error('Git sync failed:', error);
                } finally {
                    set({ isGitSyncing: false });
                }
            },

            loadGitStatus: async () => {
                const { workspacePath } = get();
                if (!workspacePath) return;

                try {
                    const status = await invoke('git_status', { repoPath: workspacePath });
                    set({ gitStatus: status });
                } catch (error) {
                    console.error('Failed to get git status:', error);
                }
            },
        }),
        {
            name: 'patto-mobile-storage',
            // Only persist these specific fields
            partialize: (state) => ({
                workspacePath: state.workspacePath,
                gitCredentials: state.gitCredentials,
                sortBy: state.sortBy,
            }),
        }
    )
);
