// Patto Mobile - Main App Component

import { useStore, View } from './lib/store';
import { FileList } from './components/FileList';
import { NoteView } from './components/NoteView';
import { NoteEditor } from './components/NoteEditor';
import { TaskPanel } from './components/TaskPanel';
import { GitConfig } from './components/GitConfig';
import { useEffect } from 'react';
import './App.css';

function App() {
  const {
    currentView,
    workspacePath,
    loadFiles,
    setView,
    goBack,
    initializeHistory,
  } = useStore();

  // Initialize browser history state and set up back button handler
  useEffect(() => {
    initializeHistory();

    const handlePopState = async (event) => {
      // Prevent default behavior and handle navigation ourselves
      const navigated = await goBack();

      if (!navigated) {
        // At root view - push a state back so next back press can be caught
        // This allows the app to close on the next back press
        history.pushState({ view: View.FILE_LIST, index: 0 }, '', '');
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [goBack, initializeHistory]);

  // Load files when workspace is set
  useEffect(() => {
    if (workspacePath) {
      loadFiles();
    }
  }, [workspacePath, loadFiles]);

  // Show config if no workspace selected
  useEffect(() => {
    if (!workspacePath) {
      setView(View.GIT_CONFIG);
    }
  }, [workspacePath, setView]);

  const renderView = () => {
    switch (currentView) {
      case View.FILE_LIST:
        return <FileList />;
      case View.NOTE_VIEW:
        return <NoteView />;
      case View.NOTE_EDIT:
        return <NoteEditor />;
      case View.TASKS:
        return <TaskPanel />;
      case View.GIT_CONFIG:
        return <GitConfig />;
      default:
        return <FileList />;
    }
  };

  return (
    <div className="app">
      {renderView()}
    </div>
  );
}

export default App;
