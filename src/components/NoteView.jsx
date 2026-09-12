// NoteView component - displays rendered note content with simple search
// Images are served natively by the Rust `pimg` URI scheme (see src-tauri/src/image_proxy.rs),
// so nothing is done for them here. Search runs against a lazily built text index.

import { useStore, View } from '../lib/store';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useMemo, useRef, useState } from 'react';
import './NoteView.css';

export function NoteView() {
    const {
        currentNote,
        renderedHtml,
        toggleEdit,
        goBack,
        openNote,
    } = useStore();

    const contentRef = useRef(null);
    const [showSearch, setShowSearch] = useState(false);
    const inputRef = useRef(null);

    // Search state: store query, current index, total matches, cached matching elements, and active element reference
    const searchRef = useRef({ query: '', idx: 0, total: 0, matches: [], activeEl: null });
    // Lowercased text of every .patto-line, built once per rendered HTML on first search
    const indexRef = useRef({ html: null, lines: [] });
    const [displayInfo, setDisplayInfo] = useState('');
    // Keep the same object across renders: React re-assigns innerHTML whenever this
    // prop's identity changes, which would rebuild the whole note DOM on every
    // search-counter update (and drop the highlighted element).
    const htmlProp = useMemo(() => ({ __html: renderedHtml }), [renderedHtml]);

    // Rendered HTML changed (navigation, save): drop stale element refs and highlights
    useEffect(() => {
        indexRef.current = { html: null, lines: [] };
        searchRef.current = { query: '', idx: 0, total: 0, matches: [], activeEl: null };
        setDisplayInfo('');
    }, [renderedHtml]);

    // Handle link clicks
    useEffect(() => {
        if (!contentRef.current) return;

        const handleClick = async (e) => {
            const link = e.target.closest('a');
            if (!link) return;

            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href) return;

            if (href.startsWith('http://') || href.startsWith('https://')) {
                try { await openUrl(href); } catch (e) { }
                return;
            }

            const [noteName] = href.split('#');
            if (noteName) {
                openNote(noteName.endsWith('.pn') ? noteName : `${noteName}.pn`);
            }
        };

        contentRef.current.addEventListener('click', handleClick);
        return () => contentRef.current?.removeEventListener('click', handleClick);
    }, [renderedHtml, openNote]);

    // Focus input when search opens
    useEffect(() => {
        if (showSearch && inputRef.current) {
            inputRef.current.focus();
        }
    }, [showSearch]);

    // Clear active search highlight directly
    const clearHighlights = () => {
        if (searchRef.current.activeEl) {
            searchRef.current.activeEl.classList.remove('search-active');
            searchRef.current.activeEl = null;
        }
    };

    // Build (once per rendered HTML) the text index: one DOM pass, no layout
    const getIndex = () => {
        if (!contentRef.current) return [];
        if (indexRef.current.html !== renderedHtml) {
            const els = contentRef.current.querySelectorAll('.patto-line');
            const lines = new Array(els.length);
            for (let i = 0; i < els.length; i++) {
                lines[i] = { el: els[i], idx: els[i].getAttribute('data-line-idx'), text: els[i].textContent.toLowerCase() };
            }
            indexRef.current = { html: renderedHtml, lines };
        }
        return indexRef.current.lines;
    };

    // Find all matching lines from the in-memory index
    const computeMatches = (query) => {
        if (!query) return [];
        const found = [];
        for (const line of getIndex()) {
            if (line.text.includes(query)) found.push(line);
        }
        return found;
    };

    // Navigate to index using cached matches in O(1) time
    const navigateToIndex = (idx) => {
        const matches = searchRef.current.matches;
        if (!matches || matches.length === 0) return;

        // Wrap index around total matches
        idx = ((idx % matches.length) + matches.length) % matches.length;
        searchRef.current.idx = idx;

        // Remove active class from previous active element
        clearHighlights();

        // Highlight current match (re-find by data-line-idx if the element was replaced)
        const match = matches[idx];
        let el = match.el;
        if (!el || !el.isConnected) {
            el = contentRef.current?.querySelector(`[data-line-idx="${match.idx}"]`);
            match.el = el;
        }
        if (el) {
            el.classList.add('search-active');
            searchRef.current.activeEl = el;
            try {
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
            } catch (e) {
                el.scrollIntoView(true);
            }
        }

        setDisplayInfo(`${idx + 1}/${matches.length}`);
    };

    // Find - starts new search and caches matches
    const doFind = () => {
        const query = inputRef.current?.value?.trim().toLowerCase();
        if (!query || !contentRef.current) {
            clearHighlights();
            searchRef.current = { query: '', idx: 0, total: 0, matches: [], activeEl: null };
            setDisplayInfo('');
            return;
        }

        clearHighlights();
        const matches = computeMatches(query);
        searchRef.current.query = query;
        searchRef.current.matches = matches;
        searchRef.current.total = matches.length;

        if (matches.length > 0) {
            navigateToIndex(0);
        } else {
            searchRef.current.idx = -1;
            setDisplayInfo('0/0');
        }
    };

    // Go to next match
    const goNext = () => {
        if (!searchRef.current.query || searchRef.current.matches.length === 0) return;
        navigateToIndex(searchRef.current.idx + 1);
    };

    // Go to previous match
    const goPrev = () => {
        if (!searchRef.current.query || searchRef.current.matches.length === 0) return;
        navigateToIndex(searchRef.current.idx - 1);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const currentQuery = inputRef.current?.value?.trim().toLowerCase();
            if (currentQuery !== searchRef.current.query) {
                doFind();
            } else if (searchRef.current.matches.length > 0) {
                if (e.shiftKey) {
                    goPrev();
                } else {
                    goNext();
                }
            } else {
                doFind();
            }
        } else if (e.key === 'Escape') {
            closeSearch();
        }
    };

    const closeSearch = () => {
        setShowSearch(false);
        clearHighlights();
        searchRef.current = { query: '', idx: 0, total: 0, matches: [], activeEl: null };
        setDisplayInfo('');
    };

    const noteName = currentNote?.replace(/\.pn$/, '') || 'Note';

    return (
        <div className="note-view">
            <header className="note-header">
                <button className="back-btn" onClick={goBack}>← Back</button>
                <h1 className="note-title">{noteName}</h1>
                <button className="edit-btn" onClick={toggleEdit}>Edit</button>
            </header>

            {showSearch && (
                <div className="search-bar">
                    <input
                        ref={inputRef}
                        type="text"
                        className="search-input"
                        placeholder="Search..."
                        onKeyDown={handleKeyDown}
                    />
                    <button type="button" className="search-action-btn" onClick={doFind}>🔍</button>
                    <span className="match-info">{displayInfo}</span>
                    <button type="button" className="search-action-btn" onClick={goPrev}>↑</button>
                    <button type="button" className="search-action-btn" onClick={goNext}>↓</button>
                    <button type="button" className="search-close-btn" onClick={closeSearch}>✕</button>
                </div>
            )}

            {!showSearch && (
                <button className="search-toggle-btn" onClick={() => setShowSearch(true)}>🔍</button>
            )}

            <article
                ref={contentRef}
                className="note-content"
                dangerouslySetInnerHTML={htmlProp}
            />
        </div>
    );
}
