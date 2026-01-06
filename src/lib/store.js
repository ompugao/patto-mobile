// Zustand store for patto-mobile
// Manages app state: workspace, files, current note, git status
// Persists key settings to localStorage

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { callSaveContext, callOnLeave, callOnEnter } from './viewHooks';
import { View, SortBy } from './constants';

// Re-export for backwards compatibility
export { View, SortBy };

// Import hooks to register them (must be after View is available)
import './noteHooks';

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
                const enterUpdates = callOnEnter(previousView, previousEntry, state);

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

            // Open a note
            openNote: async (filePath) => {
                const state = get();
                const { workspacePath, currentView, viewHistory } = state;
                if (!workspacePath) return;

                try {
                    const result = await invoke('render_note', {
                        root: workspacePath,
                        filePath
                    });

                    // Build new history entry for the new note
                    let newHistory;

                    // Use saveContext hook to get current context to save
                    const savedContext = callSaveContext(currentView, state);

                    if (savedContext) {
                        // Update the current history entry with saved context before adding new one
                        const updatedHistory = viewHistory.slice(0, -1);
                        const currentEntry = viewHistory[viewHistory.length - 1];
                        updatedHistory.push({
                            ...currentEntry,
                            ...savedContext,
                        });
                        newHistory = [...updatedHistory, { view: View.NOTE_VIEW }];
                    } else {
                        newHistory = [...viewHistory, { view: View.NOTE_VIEW }];
                    }

                    set({
                        currentNote: filePath,
                        noteContent: result.rawContent,
                        renderedHtml: result.html,
                        currentView: View.NOTE_VIEW,
                        viewHistory: newHistory,
                        isEditing: false,
                    });
                    history.pushState({ view: View.NOTE_VIEW, index: newHistory.length - 1 }, '', '');
                } catch (error) {
                    console.error('Failed to open note:', error);
                }
            },

            // Toggle edit mode
            toggleEdit: () => {
                const { isEditing, viewHistory } = get();
                const newView = isEditing ? View.NOTE_VIEW : View.NOTE_EDIT;
                const newHistory = [...viewHistory, { view: newView }];
                set({
                    isEditing: !isEditing,
                    currentView: newView,
                    viewHistory: newHistory,
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
                    // Re-render after save
                    const html = await invoke('render_content', { content: noteContent });
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
                    // Reload files after sync
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
