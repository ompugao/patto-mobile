// NoteView component - displays rendered note content with simple search
// Re-queries elements on each navigation to avoid stale DOM references

import { useStore, View } from '../lib/store';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
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
    const blobUrlsRef = useRef([]);
    const [displayInfo, setDisplayInfo] = useState('');

    // Convert local image paths to blob Object URLs (lightweight DOM footprint, fast rendering)
    useEffect(() => {
        if (!contentRef.current) return;

        let isMounted = true;

        // Clean up previously created Object URLs
        blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
        blobUrlsRef.current = [];

        const loadImages = async () => {
            const images = contentRef.current.querySelectorAll('img');
            for (const img of images) {
                const src = img.getAttribute('src');
                if (src && src.startsWith('https://asset.localhost/')) {
                    const filePath = src.replace('https://asset.localhost/', '');
                    try {
                        const [bytes, mime] = await invoke('get_image_bytes', { path: filePath });
                        if (!isMounted) return;
                        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
                        const objectUrl = URL.createObjectURL(blob);
                        blobUrlsRef.current.push(objectUrl);
                        img.src = objectUrl;
                    } catch (e) {
                        img.alt = 'Image not found';
                    }
                }
            }
        };

        loadImages();

        return () => {
            isMounted = false;
            blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
            blobUrlsRef.current = [];
        };
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

    // Find all matching elements once
    const computeMatches = (query) => {
        if (!contentRef.current || !query) return [];

        const lines = contentRef.current.querySelectorAll('.patto-line');
        const found = [];

        lines.forEach(line => {
            if (line.textContent.toLowerCase().includes(query)) {
                found.push(line);
            }
        });

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

        // Highlight current match
        const el = matches[idx];
        el.classList.add('search-active');
        searchRef.current.activeEl = el;

        try {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (e) {
            el.scrollIntoView(true);
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
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
        </div>
    );
}
